"""실시간 방송 자막 — 입장 / 작업자 입력 공유 / 턴 / 송출 이력 / 단축키

- 방은 하나뿐이고, 상태는 서버 메모리에만 있어요 (서버가 재시작되면 초기화).
- 먼저 들어온 2명이 작업자, 3번째부터는 관전자(대기열)로 들어가요.
- 새로고침이나 잠깐 끊김은 10초 안에 돌아오면 같은 자리·같은 역할·같은 입력 내용으로 복귀해요.
- 턴(main_seat)을 가진 작업자만 송출(F1)할 수 있어요.

[입력칸 동기화 방식]
작업자는 자기 칸의 전체 글을 입력할 때마다 서버로 보내요.
서버가 그 칸의 앞부분을 잘라내는 경우(F1 송출, 상대의 F8 삭제)는 "잘라내기 기록"(ext_ops)에 남기고
버전(ext_ver)을 올려요. 작업자가 그 사실을 아직 모른 채 보낸 글(옛 버전)이 도착하면
서버가 같은 잘라내기를 다시 적용해서, 잘린 어절이 되살아나지 않게 해요.
"""
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
    }


seats = [_empty_seat(i) for i in range(MAX_SEATS)]
sid_to_seat = {}

main_seat = None                      # 턴을 가진(작성중) 작업자 자리
texts = {i: "" for i in range(MAX_SEATS)}    # 자리별 입력칸 내용
ext_ver = {i: 0 for i in range(MAX_SEATS)}   # 자리별 "서버가 잘라낸" 횟수 (버전)
ext_ops = {i: [] for i in range(MAX_SEATS)}  # [(버전, 잘라낸 앞부분, "send"|"delete"), ...]
marks = {i: [] for i in range(MAX_SEATS)}    # 자리별 노란 줄 [[줄 시작, 그 줄의 \n 위치], ...]
history = ""                          # 송출 이력 전체 글

FIRST_WORD = re.compile(r"(\s*)(\S+)(\s*)")


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
                "order": s["joined_at"],
            }
            for s in seats
        ],
    }


def broadcast():
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


def cut_marks(ms, n, kind):
    """앞에서 n글자를 잘라냈을 때 노란 줄 위치를 고쳐요.
    - 잘린 부분보다 뒤에 있던 줄: 그대로 (위치만 당김)
    - 송출(send)로 줄 앞부분만 나간 줄: 남은 부분은 계속 노란색
    - 삭제(delete, F8)로 건드려진 줄 / 통째로 나간 줄: 표시 사라짐
    """
    out = []
    for a, b in ms:
        if a >= n:
            out.append([a - n, b - n])
        elif kind == "send" and n <= b - 1:
            out.append([0, b - n])
    return out


def clean_marks(raw, text):
    """브라우저가 보낸 노란 줄 목록을 검사: [시작, 줄바꿈 위치]가 실제로 한 줄 전체여야 해요."""
    out = set()
    if not isinstance(raw, list):
        return []
    for m in raw[:500]:
        try:
            a, b = int(m[0]), int(m[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if 0 <= a < b < len(text) and text[b] == "\n" and "\n" not in text[a:b] and (a == 0 or text[a - 1] == "\n"):
            out.add((a, b))
    return [list(x) for x in sorted(out)]


def cut_first_word(seat_id, kind):
    """seat_id 칸의 첫 어절을 잘라내고 모두에게 알려요. (어절, 뒤가 줄바꿈인지) 또는 None.
    kind: "send"(F1 송출) | "delete"(F8 삭제)"""
    m = FIRST_WORD.match(texts[seat_id])
    if not m:
        return None
    removed = m.group(0)  # 앞 공백 + 어절 + 뒤 공백(줄바꿈 포함)
    texts[seat_id] = texts[seat_id][len(removed):]
    marks[seat_id] = cut_marks(marks[seat_id], len(removed), kind)
    ext_ver[seat_id] += 1
    ops = ext_ops[seat_id]
    ops.append((ext_ver[seat_id], removed, kind))
    del ops[:-OPS_KEEP]
    socketio.emit("cut", {
        "seat": seat_id,
        "removed": removed,
        "kind": kind,
        "ext": ext_ver[seat_id],
        "text": texts[seat_id],
        "marks": marks[seat_id],
    })
    return m.group(2), "\n" in m.group(3)


def clear_box(seat_id):
    """칸 내용·노란 줄·잘라내기 기록을 비우고 모두에게 알려요."""
    texts[seat_id] = ""
    marks[seat_id] = []
    ext_ops[seat_id] = []
    socketio.emit("text", {"seat": seat_id, "text": "", "marks": []})


def texts_payload():
    return {
        s["id"]: {"text": texts[s["id"]], "ext": ext_ver[s["id"]], "marks": marks[s["id"]]}
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
            marks[seat_id] = []
            ext_ops[seat_id] = []
            ensure_main()
        sid_to_seat[request.sid] = seat_id
        payload = {
            "seat": seat_id,
            "token": s["token"],
            "texts": texts_payload(),
            # 재연결(새로고침 아님) 시 끊긴 동안 친 글을 살리면서 놓친 잘라내기를 적용하려고 보내요
            "my_ops": [[v, r, k] for v, r, k in ext_ops[seat_id]],
            "history": history,
        }

    emit("joined", payload)
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
    """작업자가 자기 칸 전체 글을 보내요. {text, ext: 작업자가 알고 있는 잘라내기 버전, marks: 노란 줄}"""
    data = data or {}
    text = data.get("text")
    if not isinstance(text, str):
        return
    text = text[:TEXT_MAX]
    ms = data.get("marks") if isinstance(data.get("marks"), list) else []
    try:
        known = int(data.get("ext", 0))
    except (TypeError, ValueError):
        known = 0
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return
        if known < ext_ver[seat_id]:
            # 작업자가 아직 모르는 잘라내기(F1/F8)를 그 글과 노란 줄에도 똑같이 적용
            for ver, removed, kind in ext_ops[seat_id]:
                if ver > known and text.startswith(removed):
                    text = text[len(removed):]
                    ms = cut_marks(clean_marks(ms, removed + text), len(removed), kind)
        texts[seat_id] = text
        marks[seat_id] = clean_marks(ms, text)
        socketio.emit("text", {"seat": seat_id, "text": text, "marks": marks[seat_id]}, skip_sid=request.sid)


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
        if texts[me_id].strip() and not confirm:
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

@socketio.on("send_word")
def on_send_word():
    """F1: 턴 주인의 칸에서 첫 어절을 잘라 송출 이력에 이어 붙여요."""
    global history
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id) or seat_id != main_seat:
            return emit("toast", {"message": "작성중인 작업자만 송출할 수 있어요. (지금은 대기중)"})
        cut = cut_first_word(seat_id, "send")
        if cut is None:
            return emit("toast", {"message": "송출할 내용이 없어요."})
        word, newline = cut
        chunk = word if (history == "" or history.endswith("\n")) else " " + word
        if newline:
            chunk += "\n"
        history += chunk
        socketio.emit("history_append", {"chunk": chunk})


@socketio.on("delete_partner_word")
def on_delete_partner_word():
    """F8: 상대 작업자 칸의 첫 어절을 지워요."""
    with lock:
        seat_id = my_seat()
        if not is_worker(seat_id):
            return emit("toast", {"message": "작업자만 상대 칸을 지울 수 있어요."})
        other = other_worker(seat_id)
        if other is None:
            return emit("toast", {"message": "상대 작업자가 없어요."})
        if cut_first_word(other, "delete") is None:
            return emit("toast", {"message": "상대 칸에 지울 내용이 없어요."})


@socketio.on("clear_history")
def on_clear_history():
    global history
    with lock:
        if not is_worker(my_seat()):
            return emit("toast", {"message": "작업자만 송출 이력을 초기화할 수 있어요."})
        history = ""
        socketio.emit("history_full", {"history": ""})
    emit("toast", {"message": "송출 이력을 초기화했어요."})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
