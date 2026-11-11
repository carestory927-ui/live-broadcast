"""실시간 방송 자막 — 입장 / 작업자 입력 공유 / 턴 / 송출 이력 / 단축키

- 방은 하나뿐이고, 상태는 서버 메모리에만 있어요 (서버가 재시작되면 초기화).
- 먼저 들어온 2명이 작업자, 3번째부터는 관전자(대기열)로 들어가요.
- 새로고침이나 잠깐 끊김은 10초 안에 돌아오면 같은 자리·같은 역할·같은 입력 내용으로 복귀해요.
- 턴(main_seat)을 가진 작업자만 송출(F1)할 수 있어요.

[입력칸 동기화 방식]
작업자는 자기 칸의 전체 글을 입력할 때마다 서버로 보내요. 칸의 글을 바꾸는 건 언제나 그 칸 주인의 브라우저예요
(상대의 F8 삭제도 서버가 주인 브라우저에 "지워줘"라고 전달해서 주인이 지워요).

[송출 위치]
칸마다 "어디까지 송출됐는지"(sent, 글자 위치)를 서버가 관리해요. 앞쪽 [0, sent)는 송출된 부분이라 고칠 수 없고
파란 배경으로 보여요. 작성중 작업자의 브라우저가 "여기까지 송출" 요청(send_upto)을 보내면 서버가 검사한 뒤
그 사이 어절들을 송출 이력에 붙이고 sent를 옮겨요 (자동 송출 / F1 / Insert).

[송출된 부분 정리]
송출된 부분이 길어지면 서버가 칸 앞쪽(송출된 부분)을 잘라내요. 이 잘라내기만 "잘라내기 기록"(ext_ops)에 남기고
버전(ext_ver)을 올려요. 작업자가 그 사실을 아직 모른 채 보낸 글(옛 버전)이 도착하면 서버가 같은 잘라내기를
다시 적용하고, 옛 버전 기준의 송출 위치도 그만큼 당겨서 해석해요.
"""
import json
import os
import re
import secrets
import threading
import time

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", secrets.token_hex(16))
# async_handlers=False: 한 사람이 보낸 이벤트를 보낸 순서 그대로 처리해요
# (예: "입력 내용" → "송출" 순서가 뒤바뀌면 안 되니까요). 사람끼리는 여전히 동시에 처리돼요.
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*", async_handlers=False)

MAX_SEATS = 6        # 작업자 버튼 개수 (작업자 2 + 관전자 4)
MAX_WORKERS = 2      # 동시에 치는 작업자 수
GRACE_SECONDS = 10   # 연결이 끊겨도 자리를 잡아두는 시간
NAME_MAX = 12
TEXT_MAX = 20000     # 입력칸 하나의 최대 글자 수
OPS_KEEP = 100       # 칸마다 기억해 둘 잘라내기 기록 수

lock = threading.RLock()

# ---------- 상용구 (작업자 이름별, 서버 파일에 저장) ----------
# DATA_DIR/snippets.json = { "작업자 이름": { "입력어": "출력어", ... }, ... }
# Railway에선 Volume을 /data에 붙이고 DATA_DIR=/data 로 두면 재배포해도 남아요.
DATA_DIR = os.environ.get("DATA_DIR", "./data")
SNIPPETS_FILE = os.path.join(DATA_DIR, "snippets.json")
SNIP_KEY_MAX = 50
SNIP_OUT_MAX = 2000
SNIP_PER_USER = 3000
snip_lock = threading.Lock()


def _load_snippets():
    try:
        with open(SNIPPETS_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"[snippets] {SNIPPETS_FILE} 읽기 실패: {e}", flush=True)
        return {}
    out = {}
    if isinstance(raw, dict):
        for name, d in raw.items():
            if isinstance(name, str) and isinstance(d, dict):
                out[name] = {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, str)}
    return out


snippets = _load_snippets()


def _save_snippets():
    """임시 파일에 쓴 뒤 바꿔치기 → 저장 도중 꺼져도 파일이 깨지지 않아요. snip_lock 안에서 호출."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = SNIPPETS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(snippets, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SNIPPETS_FILE)


def _empty_seat(i, name=None):
    return {
        "id": i,
        "name": name or f"작업자{i + 1}",
        "token": None,      # 자리 주인 확인용 (브라우저에 저장)
        "sid": None,        # 현재 연결 id
        "role": None,       # "worker" | "spectator" | None
        "joined_at": None,
        "online": False,
        "ready": False,     # 관전자의 초록불 (작업하고 싶다는 신호)
        "standby": False,   # 대기 작업자의 노란 창 (Enter → 이어받을 준비 됐다는 신호)
    }


seats = [_empty_seat(i) for i in range(MAX_SEATS)]
sid_to_seat = {}

main_seat = None                      # 턴을 가진(작성중) 작업자 자리
texts = {i: "" for i in range(MAX_SEATS)}    # 자리별 입력칸 내용
ext_ver = {i: 0 for i in range(MAX_SEATS)}   # 자리별 "서버가 잘라낸" 횟수 (버전)
ext_ops = {i: [] for i in range(MAX_SEATS)}  # [(버전, 잘라낸 앞부분), ...] — 송출된 부분 정리 기록
sent = {i: 0 for i in range(MAX_SEATS)}      # 자리별 송출 위치: texts[i][:sent[i]]는 이미 송출됨
history = ""                          # 송출 이력 전체 글

FIRST_WORD = re.compile(r"(\s*)(\S+)(\s*)")
TRIM_AT = 500        # 송출된 부분이 이만큼 쌓이면
TRIM_KEEP = 200      # 뒤쪽 이만큼만 남기고 앞을 정리


# ---------- 상태 도우미 ----------

def public_state():
    return {
        "max_workers": MAX_WORKERS,
        "main_seat": main_seat,
        "seats": [
            {
                "id": s["id"],
                "name": s["name"],
                "taken": s["token"] is not None,
                "role": s["role"],
                "online": s["online"],
                "ready": s["ready"],
                "standby": s["standby"],
                "order": s["joined_at"],
            }
            for s in seats
        ],
    }


def broadcast():
    # 턴을 받은 작업자의 노란 창은 꺼요 (턴이 바뀌는 모든 경로를 여기서 한 번에 처리)
    if main_seat is not None:
        seats[main_seat]["standby"] = False
    socketio.emit("state", public_state())


def is_worker(seat_id):
    return seat_id is not None and seats[seat_id]["token"] is not None and seats[seat_id]["role"] == "worker"


def workers_in_order():
    return sorted((s for s in seats if s["token"] and s["role"] == "worker"), key=lambda s: s["joined_at"])


def worker_count():
    return len(workers_in_order())


def other_worker(seat_id):
    for s in workers_in_order():
        if s["id"] != seat_id:
            return s["id"]
    return None


def ensure_main():
    """턴 주인이 없거나 작업자가 아니면, 가장 먼저 온 작업자에게 턴을 줘요."""
    global main_seat
    if is_worker(main_seat):
        return
    ws = workers_in_order()
    main_seat = ws[0]["id"] if ws else None


def promote_spectators():
    """작업자 자리가 비면 가장 먼저 온 관전자를 작업자로 올려요."""
    while worker_count() < MAX_WORKERS:
        waiting = sorted(
            (s for s in seats if s["token"] and s["role"] == "spectator"),
            key=lambda s: s["joined_at"],
        )
        if not waiting:
            break
        waiting[0]["role"] = "worker"
        waiting[0]["ready"] = False


def release_seat(seat_id):
    name = seats[seat_id]["name"]
    seats[seat_id] = _empty_seat(seat_id, name)  # 이름은 남겨둬요
    clear_box(seat_id)
    promote_spectators()
    ensure_main()


def release_if_still_offline(seat_id, token):
    with lock:
        s = seats[seat_id]
        if s["token"] != token or s["online"]:
            return
        release_seat(seat_id)
    broadcast()


def clean_name(raw):
    name = (raw or "").strip()[:NAME_MAX]
    return name or None


def my_seat():
    """지금 이 연결(request.sid)이 앉아 있는 자리 번호. 없으면 None."""
    seat_id = sid_to_seat.get(request.sid)
    if seat_id is None or seats[seat_id]["sid"] != request.sid:
        return None
    return seat_id


def unsent_text(seat_id):
    return texts[seat_id][sent[seat_id]:]


def history_chunk(region):
    """송출되는 구간 글 → 송출 이력에 붙일 글. 어절 사이는 띄어쓰기 하나, 줄바꿈은 그대로 한 번."""
    out = ""

    def at_line_start():
        tail = (history + out)[-1:]
        return tail == "" or tail == "\n"

    lead = re.match(r"\s*", region).group(0)
    if "\n" in lead and not at_line_start():
        out += "\n"
    for m in re.finditer(r"(\S+)(\s*)", region):
        out += m.group(1) if at_line_start() else " " + m.group(1)
        if "\n" in m.group(2):
            out += "\n"
    return out


def trim_sent(seat_id):
    """송출된 부분이 TRIM_AT 이상이면 앞쪽을 어절 경계에서 잘라내고 모두에게 알려요."""
    S = sent[seat_id]
    if S < TRIM_AT:
        return
    T = texts[seat_id]
    k = S - TRIM_KEEP
    while k < S and not T[k - 1].isspace():
        k += 1
    if k <= 0:
        return
    removed = T[:k]
    texts[seat_id] = T[k:]
    sent[seat_id] = S - k
    ext_ver[seat_id] += 1
    ops = ext_ops[seat_id]
    ops.append((ext_ver[seat_id], removed))
    del ops[:-OPS_KEEP]
    socketio.emit("cut", {
        "seat": seat_id,
        "removed": removed,
        "ext": ext_ver[seat_id],
        "text": texts[seat_id],
        "sent": sent[seat_id],
    })


def clear_box(seat_id, skip_sid=None):
    """칸 내용·송출 위치·노란 창·잘라내기 기록을 비우고 모두에게 알려요."""
    texts[seat_id] = ""
    sent[seat_id] = 0
    ext_ops[seat_id] = []
    seats[seat_id]["standby"] = False
    socketio.emit("text", {"seat": seat_id, "text": "", "sent": 0, "ext": ext_ver[seat_id], "reset": True},
                  skip_sid=skip_sid)


def texts_payload():
    return {
        s["id"]: {"text": texts[s["id"]], "ext": ext_ver[s["id"]], "sent": sent[s["id"]]}
        for s in workers_in_order()
    }


# ---------- 화면 ----------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/health")
def health():
    return {"ok": True}


# ---------- 실시간 이벤트: 입장 / 이름 / 나가기 ----------

@socketio.on("connect")
def on_connect():
    emit("state", public_state())


@socketio.on("join")
def on_join(data):
    data = data or {}
    try:
        seat_id = int(data.get("seat"))
    except (TypeError, ValueError):
        return emit("join_error", {"message": "잘못된 자리예요.", "clear": True})
    if not 0 <= seat_id < MAX_SEATS:
        return emit("join_error", {"message": "잘못된 자리예요.", "clear": True})

    token = data.get("token")
    with lock:
        s = seats[seat_id]
        if s["token"] is not None:
            if token and token == s["token"]:
                # 새로고침/재연결 → 같은 자리로 복귀
                if s["sid"]:
                    sid_to_seat.pop(s["sid"], None)
                s["sid"] = request.sid
                s["online"] = True
            else:
                return emit("join_error", {
                    "message": f"'{s['name']}' 자리는 이미 사용 중이에요.",
                    "clear": bool(token),
                })
        else:
            if token:
                # 예전 토큰인데 자리가 이미 풀렸으면 새로 입장하도록 안내
                return emit("join_error", {
                    "message": "연결이 오래 끊겨서 자리가 풀렸어요. 다시 입장해주세요.",
                    "clear": True,
                })
            s["token"] = secrets.token_hex(12)
            s["sid"] = request.sid
            s["online"] = True
            s["joined_at"] = time.time()
            s["role"] = "worker" if worker_count() < MAX_WORKERS else "spectator"
            texts[seat_id] = ""
            sent[seat_id] = 0
            ext_ops[seat_id] = []
            ensure_main()
        sid_to_seat[request.sid] = seat_id
        payload_name = s["name"]
        payload = {
            "seat": seat_id,
            "token": s["token"],
            "texts": texts_payload(),
            # 재연결(새로고침 아님) 시 끊긴 동안 친 글을 살리면서 놓친 잘라내기를 적용하려고 보내요
            "my_ops": [[v, r] for v, r in ext_ops[seat_id]],
            "history": history,
            "video": video_msg(),
        }

    emit("joined", payload)
    emit("snippets", snippets_payload(payload_name))
    broadcast()


@socketio.on("rename")
def on_rename(data):
    data = data or {}
    try:
        seat_id = int(data.get("seat"))
    except (TypeError, ValueError):
        return
    name = clean_name(data.get("name"))
    if not name or not 0 <= seat_id < MAX_SEATS:
        return emit("toast", {"message": "이름을 입력해주세요."})
    with lock:
        s = seats[seat_id]
        mine = sid_to_seat.get(request.sid) == seat_id
        if s["token"] is not None and not mine:
            return emit("toast", {"message": "다른 사람이 쓰고 있는 자리는 이름을 바꿀 수 없어요."})
        s["name"] = name
        sid = s["sid"] if mine else None
    if sid:
        socketio.emit("snippets", snippets_payload(name), to=sid)  # 이름이 바뀌면 그 이름의 상용구로
    broadcast()


@socketio.on("leave")
def on_leave():
    with lock:
        seat_id = sid_to_seat.pop(request.sid, None)
        if seat_id is None:
            return
        release_seat(seat_id)
    emit("left")
    broadcast()


@socketio.on("disconnect")
def on_disconnect(*_args):
    with lock:
        seat_id = sid_to_seat.pop(request.sid, None)
        if seat_id is None:
            return
        s = seats[seat_id]
        if s["sid"] != request.sid:
            return
        s["online"] = False
        s["sid"] = None
        token = s["token"]
    t = threading.Timer(GRACE_SECONDS, release_if_still_offline, args=(seat_id, token))
    t.daemon = True
    t.start()
    broadcast()


# ---------- 실시간 이벤트: 입력 공유 / 턴 ----------

@socketio.on("text")
def on_text(data):
    """작업자가 자기 칸 전체 글을 보내요. {text, ext: 작업자가 알고 있는 잘라내기 버전}"""
    data = data or {}
    text = data.get("text")
    if not isinstance(text, str):
        return
    text = text[:TEXT_MAX]
    try:
        known = int(data.get("ext", 0))
    except (TypeError, ValueError):
        known = 0
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return
        if known < ext_ver[seat_id]:
            # 작업자가 아직 모르는 정리(앞부분 잘라내기)를 그 글에도 똑같이 적용
            for ver, removed in ext_ops[seat_id]:
                if ver > known and text.startswith(removed):
                    text = text[len(removed):]
        prefix = texts[seat_id][:sent[seat_id]]
        if not text.startswith(prefix):
            # 송출된 부분이 바뀐 글 → 받지 않고 주인 브라우저를 서버 글로 맞춰요 (정상이라면 일어나지 않아요)
            return emit("resync", {"text": texts[seat_id], "sent": sent[seat_id], "ext": ext_ver[seat_id]})
        texts[seat_id] = text
        socketio.emit("text", {"seat": seat_id, "text": text, "sent": sent[seat_id], "ext": ext_ver[seat_id]},
                      skip_sid=request.sid)


@socketio.on("standby")
def on_standby():
    """대기 작업자가 자기 칸에서 Enter → 칸 전체가 노란 창 (이어받을 준비 됐다는 신호)."""
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id) or seat_id == main_seat or seats[seat_id]["standby"]:
            return
        seats[seat_id]["standby"] = True
    broadcast()


@socketio.on("clear_mine")
def on_clear_mine():
    """F12: 내 칸 전체 지우기 + 송출 위치 초기화 + 노란 창 끄기. 응답: {ok, ext}"""
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return {"ok": False}
        ext_ver[seat_id] += 1  # 그 전에 보낸 정리(잘라내기)는 지운 칸에 적용하지 않게
        clear_box(seat_id, skip_sid=request.sid)  # 주인 칸은 이미 비웠어요 (그 뒤 친 글을 지우지 않게)
        ext = ext_ver[seat_id]
    broadcast()
    return {"ok": True, "ext": ext}


@socketio.on("pass_turn")
def on_pass_turn():
    global main_seat
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id) or seat_id != main_seat:
            return emit("toast", {"message": "작성중일 때만 턴을 넘길 수 있어요."})
        other = other_worker(seat_id)
        if other is None:
            return emit("toast", {"message": "턴을 넘길 상대 작업자가 없어요."})
        main_seat = other
        other_sid = seats[other]["sid"]
        my_name = seats[seat_id]["name"]
    if other_sid:
        socketio.emit("toast", {"message": f"{my_name}님이 턴을 넘겼어요. 이제 작성중이에요."}, to=other_sid)
    broadcast()


# ---------- 실시간 이벤트: 대기열 초록불 / 자리 교체 ----------

@socketio.on("toggle_ready")
def on_toggle_ready():
    """관전자가 자기 칩을 눌러 초록불을 켜고 꺼요."""
    with lock:
        seat_id = my_seat()
        if seat_id is None or seats[seat_id]["role"] != "spectator":
            return emit("toast", {"message": "관전자만 자기 초록불을 켤 수 있어요."})
        seats[seat_id]["ready"] = not seats[seat_id]["ready"]
    broadcast()


@socketio.on("swap")
def on_swap(data):
    """작업자가 초록불 켜진 관전자 칩을 눌러 자리를 바꿔요. {target, confirm}"""
    global main_seat
    data = data or {}
    try:
        target = int(data.get("target"))
    except (TypeError, ValueError):
        return
    confirm = bool(data.get("confirm"))
    with lock:
        me_id = my_seat()
        if not is_worker(me_id):
            return emit("toast", {"message": "작업자만 자리를 바꿀 수 있어요."})
        if not 0 <= target < MAX_SEATS:
            return
        t = seats[target]
        if t["token"] is None or t["role"] != "spectator" or not t["ready"]:
            return  # 초록불이 꺼진 칩(또는 이미 바뀐 자리) → 아무 일 없음
        if not t["online"]:
            return emit("toast", {"message": f"{t['name']}님이 연결 끊김 상태라 바꿀 수 없어요."})
        if unsent_text(me_id).strip() and not confirm:
            return emit("swap_confirm", {"target": target})

        w = seats[me_id]
        # 관전자는 작업자의 자리 순서를 그대로 이어받고, 작업자는 대기열 맨 뒤로
        t["joined_at"], w["joined_at"] = w["joined_at"], time.time()
        t["role"], w["role"] = "worker", "spectator"
        t["ready"] = w["ready"] = False
        if main_seat == me_id:
            main_seat = target
        for sid_ in (me_id, target):  # 두 칸 모두 빈 칸으로 새로 시작 (작업자의 남은 글은 삭제)
            clear_box(sid_)
        target_sid = t["sid"]
        msg = f"{w['name']}님과 자리를 바꿨어요. 이제 작업자예요" + (" (작성중)." if main_seat == target else ".")
    socketio.emit("toast", {"message": msg}, to=target_sid)
    emit("toast", {"message": f"{t['name']}님과 자리를 바꿨어요. 이제 관전자예요."})
    broadcast()


# ---------- 실시간 이벤트: 송출 / 상대 칸 삭제 / 이력 ----------

@socketio.on("send_upto")
def on_send_upto(data):
    """작성중 작업자의 칸에서 [sent, offset) 구간을 송출해요. {offset, ext}
    자동 송출(완성 어절 3개 → 맨 앞 1개), F1(첫 어절), Insert(남은 글 전부)가 모두 이걸 써요.
    응답: {ok, sent, ext, message?} — sent/ext는 서버 기준 최신 값"""
    global history
    data = data or {}
    try:
        offset = int(data.get("offset"))
        known = int(data.get("ext", 0))
    except (TypeError, ValueError):
        return {"ok": False, "sent": 0, "ext": 0}
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return {"ok": False, "sent": 0, "ext": 0, "message": "작업자만 송출할 수 있어요."}

        def result(ok, message=None):
            r = {"ok": ok, "sent": sent[seat_id], "ext": ext_ver[seat_id]}
            if message:
                r["message"] = message
            return r

        if seat_id != main_seat:
            return result(False, "작성중인 작업자만 송출할 수 있어요. (지금은 대기중)")
        if known < ext_ver[seat_id]:
            # 옛 버전 기준 위치 → 그 뒤 정리로 잘린 만큼 당겨서 해석
            ops = [r for v, r in ext_ops[seat_id] if v > known]
            if len(ops) != ext_ver[seat_id] - known:
                return result(False)
            offset -= sum(len(r) for r in ops)
        S, T = sent[seat_id], texts[seat_id]
        if offset <= S:
            return result(True)  # 이미 송출됨 (같은 요청이 두 번 와도 한 번만)
        if offset > len(T) or not (offset == len(T) or T[offset - 1].isspace()):
            return result(False)
        chunk = history_chunk(T[S:offset])
        sent[seat_id] = offset
        if chunk:
            history += chunk
            socketio.emit("history_append", {"chunk": chunk})
        socketio.emit("sent", {"seat": seat_id, "sent": offset, "ext": ext_ver[seat_id]}, skip_sid=request.sid)
        trim_sent(seat_id)
        return result(True)


@socketio.on("delete_partner_word")
def on_delete_partner_word():
    """F8: 상대 작업자 칸의 '송출 안 된 첫 어절'을 지워요. 상대 브라우저가 직접 지우도록 전달."""
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return emit("toast", {"message": "작업자만 상대 칸을 지울 수 있어요."})
        other = other_worker(seat_id)
        if other is None:
            return emit("toast", {"message": "상대 작업자가 없어요."})
        if not FIRST_WORD.match(unsent_text(other)):
            return emit("toast", {"message": "상대 칸에 지울 내용이 없어요. (송출된 글은 지울 수 없어요)"})
        other_sid = seats[other]["sid"]
        if not other_sid:
            return emit("toast", {"message": "상대가 연결 끊김 상태라 지울 수 없어요."})
    socketio.emit("delete_first", {}, to=other_sid)


# ---------- 실시간 이벤트: 영상 같이 보기 ----------
# video = {"id": 영상ID, "playing": 재생중?, "pos": 기준 시간(초), "at": 기준 시각(서버 time.time())}
# 지금 위치 = playing이면 pos + (지금 - at), 아니면 pos. 나중에 들어온 사람도 이걸로 현재 위치부터 봐요.
video = None
YT_ID = re.compile(r"^[\w-]{11}$")


def video_msg(by=None):
    return {"video": dict(video) if video else None, "now": time.time(), "by": by}


@socketio.on("clock")
def on_clock():
    """브라우저가 서버 시계와의 차이를 재요 (영상 위치 계산용)."""
    return {"now": time.time()}


def _clean_pos(raw):
    try:
        pos = float(raw)
    except (TypeError, ValueError):
        return None
    if pos != pos or pos < 0:  # NaN / 음수
        return 0.0
    return min(pos, 7 * 24 * 3600.0)


@socketio.on("video_open")
def on_video_open(data):
    """작업자가 유튜브 영상을 열어요 → 모두의 화면에 같은 영상이 재생돼요. {id, start}"""
    global video
    data = data or {}
    vid = data.get("id")
    start = _clean_pos(data.get("start", 0)) or 0.0
    if not isinstance(vid, str) or not YT_ID.match(vid):
        return emit("toast", {"message": "유튜브 영상 ID가 잘못됐어요."})
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return emit("toast", {"message": "영상은 작업자만 열 수 있어요."})
        video = {"id": vid, "playing": True, "pos": start, "at": time.time()}
        msg = video_msg(seats[seat_id]["name"])
    socketio.emit("video", msg)


@socketio.on("video_ctrl")
def on_video_ctrl(data):
    """작업자의 재생/일시정지/시간 이동 → 모두에게. {action: play|pause|seek, pos: 그 순간 영상 시간}"""
    data = data or {}
    action = data.get("action")
    pos = _clean_pos(data.get("pos"))
    if action not in ("play", "pause", "seek") or pos is None:
        return
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return emit("toast", {"message": "영상 조작은 작업자만 할 수 있어요."})
        if video is None:
            return
        if action != "seek":
            video["playing"] = action == "play"
        video["pos"] = pos
        video["at"] = time.time()
        msg = video_msg(seats[seat_id]["name"])
    socketio.emit("video", msg)


@socketio.on("clear_history")
def on_clear_history():
    global history
    with lock:
        if not is_worker(my_seat()):
            return emit("toast", {"message": "작업자만 송출 이력을 초기화할 수 있어요."})
        history = ""
        socketio.emit("history_full", {"history": ""})
    emit("toast", {"message": "송출 이력을 초기화했어요."})


# ---------- 실시간 이벤트: 상용구 (작업자 이름별) ----------
# 이름은 브라우저가 보낸 값이 아니라 "지금 이 연결이 앉은 자리의 이름"을 써요 → 다른 작업자 것과 섞이지 않아요.

def snippets_payload(name):
    with snip_lock:
        return {"name": name, "items": dict(snippets.get(name, {}))}


def my_name():
    with lock:
        seat_id = my_seat()
        return None if seat_id is None else seats[seat_id]["name"]


def push_snippets(name):
    """같은 이름으로 앉아 있는 모든 연결(다른 탭 포함)에 최신 목록을 보내요."""
    payload = snippets_payload(name)
    with lock:
        sids = [s["sid"] for s in seats if s["token"] and s["sid"] and s["name"] == name]
    for sid in sids:
        socketio.emit("snippets", payload, to=sid)


@socketio.on("snippets_get")
def on_snippets_get():
    name = my_name()
    if name is not None:
        emit("snippets", snippets_payload(name))


@socketio.on("snippet_set")
def on_snippet_set(data):
    """{key, out} — 입력어/출력어는 앞뒤 공백만 떼고 그대로 저장. 응답: {ok, key, out, replaced} 또는 {ok: False, message}"""
    data = data or {}
    key, out = data.get("key"), data.get("out")
    if not isinstance(key, str) or not isinstance(out, str):
        return {"ok": False, "message": "잘못된 상용구예요."}
    key, out = key.strip(), out.strip()
    if not key or not out or any(c.isspace() for c in key):
        return {"ok": False, "message": "입력어(띄어쓰기 없이)와 출력어를 모두 써주세요."}
    if len(key) > SNIP_KEY_MAX or len(out) > SNIP_OUT_MAX:
        return {"ok": False, "message": f"너무 길어요. (입력어 {SNIP_KEY_MAX}자, 출력어 {SNIP_OUT_MAX}자까지)"}
    name = my_name()
    if name is None:
        return {"ok": False, "message": "입장한 뒤에 등록할 수 있어요."}
    with snip_lock:
        mine = snippets.setdefault(name, {})
        if key not in mine and len(mine) >= SNIP_PER_USER:
            return {"ok": False, "message": f"상용구는 {SNIP_PER_USER}개까지 등록할 수 있어요."}
        prev = mine.get(key)
        mine[key] = out
        try:
            _save_snippets()
        except OSError as e:
            if prev is None:
                mine.pop(key, None)
            else:
                mine[key] = prev
            print(f"[snippets] 저장 실패: {e}", flush=True)
            return {"ok": False, "message": "서버에 상용구를 저장하지 못했어요."}
    push_snippets(name)
    return {"ok": True, "key": key, "out": out, "replaced": prev is not None and prev != out}


@socketio.on("snippet_del")
def on_snippet_del(data):
    data = data or {}
    key = data.get("key")
    name = my_name()
    if not isinstance(key, str) or name is None:
        return {"ok": False, "message": "삭제할 수 없어요."}
    with snip_lock:
        mine = snippets.get(name, {})
        if key not in mine:
            return {"ok": True, "key": key}
        prev = mine.pop(key)
        if not mine:
            snippets.pop(name, None)
        try:
            _save_snippets()
        except OSError as e:
            snippets.setdefault(name, {})[key] = prev
            print(f"[snippets] 저장 실패: {e}", flush=True)
            return {"ok": False, "message": "서버에 상용구를 저장하지 못했어요."}
    push_snippets(name)
    return {"ok": True, "key": key}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
