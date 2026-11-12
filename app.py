"""실시간 방송 자막 — 방 선택 / 입장 / 작업자 입력 공유 / 턴 / 송출 이력 / 단축키

- 방이 NUM_ROOMS개 있고(/room/1, /room/2, ...), 방마다 자리·턴·입력칸·송출 이력·노란 창·대기열·영상이
  완전히 따로예요. 방 하나의 상태는 Room 객체 하나에 모여 있고, 그 방 이벤트는 Socket.IO room("room-<번호>")으로만
  보내요 → 다른 방과 섞이지 않아요. 방 개수는 NUM_ROOMS 숫자 하나만 바꾸면 늘어나요.
- 상태는 서버 메모리에만 있어요 (서버가 재시작되면 초기화). 방 이름과 상용구만 파일에 저장해요.
- 방마다 먼저 들어온 2명이 작업자, 3번째부터는 관전자(대기열)로 들어가요.
- 새로고침이나 잠깐 끊김은 10초 안에 돌아오면 같은 방·같은 자리·같은 역할·같은 입력 내용으로 복귀해요.
- 턴(main_seat)을 가진 작업자만 송출(F1)할 수 있어요.
- 상용구는 방과 상관없이 작업자 이름별로 저장돼요.

[연결과 방]
연결(sid)마다 "보고 있는 방"(watch)과 "앉은 자리"가 있어요. 방 카드를 누르면 그 방을 보고(Socket.IO room 입장)
그 방의 자리 화면·상태를 받아요. 자리에 앉으면(join) 그 방의 작업자/관전자가 돼요. 방 목록 화면에 있는 연결은
어느 방도 보지 않고, 방마다 인원 요약("rooms")만 받아요.

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
import hashlib
import json
import os
import re
import secrets
import threading
import time

from flask import Flask, make_response, redirect, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", secrets.token_hex(16))
# async_handlers=False: 한 사람이 보낸 이벤트를 보낸 순서 그대로 처리해요
# (예: "입력 내용" → "송출" 순서가 뒤바뀌면 안 되니까요). 사람끼리는 여전히 동시에 처리돼요.
socketio = SocketIO(app, async_mode="threading", cors_allowed_origins="*", async_handlers=False)

NUM_ROOMS = 3        # 방 개수 — 이 숫자만 바꾸면 방이 늘어나요
MAX_SEATS = 6        # 방마다 자리 버튼 개수 (작업자 2 + 관전자 4)
MAX_WORKERS = 2      # 방마다 동시에 치는 작업자 수
GRACE_SECONDS = 10   # 연결이 끊겨도 자리를 잡아두는 시간
NAME_MAX = 12
ROOM_NAME_MAX = 20
TEXT_MAX = 20000     # 입력칸 하나의 최대 글자 수
OPS_KEEP = 100       # 칸마다 기억해 둘 잘라내기 기록 수

FIRST_WORD = re.compile(r"(\s*)(\S+)(\s*)")
TRIM_AT = 500        # 송출된 부분이 이만큼 쌓이면
TRIM_KEEP = 200      # 뒤쪽 이만큼만 남기고 앞을 정리
YT_ID = re.compile(r"^[\w-]{11}$")

lock = threading.RLock()

# ---------- 파일 저장 (상용구 / 방 이름) ----------
# Railway에선 Volume을 /data에 붙이고 DATA_DIR=/data 로 두면 재배포해도 남아요.
DATA_DIR = os.environ.get("DATA_DIR", "./data")
SNIPPETS_FILE = os.path.join(DATA_DIR, "snippets.json")   # { "작업자 이름": { "입력어": "출력어" } }
ROOMS_FILE = os.path.join(DATA_DIR, "rooms.json")         # { "1": "방 이름", ... }
SNIP_KEY_MAX = 50
SNIP_OUT_MAX = 2000
SNIP_PER_USER = 3000
snip_lock = threading.Lock()


def _load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        print(f"[data] {path} 읽기 실패: {e}", flush=True)
        return None


def _save_json(path, obj):
    """임시 파일에 쓴 뒤 바꿔치기 → 저장 도중 꺼져도 파일이 깨지지 않아요."""
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _load_snippets():
    raw = _load_json(SNIPPETS_FILE)
    out = {}
    if isinstance(raw, dict):
        for name, d in raw.items():
            if isinstance(name, str) and isinstance(d, dict):
                out[name] = {k: v for k, v in d.items() if isinstance(k, str) and isinstance(v, str)}
    return out


snippets = _load_snippets()


def _save_snippets():
    """snip_lock 안에서 호출."""
    _save_json(SNIPPETS_FILE, snippets)


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


def clean_name(raw, limit=NAME_MAX):
    name = (raw or "").strip()[:limit]
    return name or None


# ---------- 방 ----------

class Room:
    """방 하나의 모든 상태. 이 방으로 가는 이벤트는 전부 self.emit(→ Socket.IO room)으로 보내요."""

    def __init__(self, rid, name=None):
        self.id = rid
        self.name = name or f"방 {rid}"
        self.channel = f"room-{rid}"
        self.seats = [_empty_seat(i) for i in range(MAX_SEATS)]
        self.main_seat = None                         # 턴을 가진(작성중) 작업자 자리
        self.texts = {i: "" for i in range(MAX_SEATS)}    # 자리별 입력칸 내용
        self.ext_ver = {i: 0 for i in range(MAX_SEATS)}   # 자리별 "서버가 잘라낸" 횟수 (버전)
        self.ext_ops = {i: [] for i in range(MAX_SEATS)}  # [(버전, 잘라낸 앞부분), ...]
        self.sent = {i: 0 for i in range(MAX_SEATS)}      # 자리별 송출 위치: texts[i][:sent[i]]는 송출됨
        self.history = ""                             # 송출 이력 전체 글
        # 영상 = {"id", "playing", "pos": 기준 시간(초), "at": 기준 시각(서버 time.time())}
        self.video = None

    def emit(self, event, data=None, **kw):
        socketio.emit(event, data, to=self.channel, **kw)

    # ----- 상태 -----
    def public_state(self):
        return {
            "room": self.id,
            "room_name": self.name,
            "max_workers": MAX_WORKERS,
            "main_seat": self.main_seat,
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
                for s in self.seats
            ],
        }

    def summary(self):
        taken = [s for s in self.seats if s["token"]]
        return {
            "id": self.id,
            "name": self.name,
            "workers": sum(1 for s in taken if s["role"] == "worker"),
            "spectators": sum(1 for s in taken if s["role"] == "spectator"),
            "max_seats": MAX_SEATS,
            "max_workers": MAX_WORKERS,
        }

    def broadcast(self):
        """이 방 사람들에게 상태를, 모두에게 방 목록 요약을 보내요. lock 밖에서 불러도 돼요."""
        with lock:
            # 턴을 받은 작업자의 노란 창은 꺼요 (턴이 바뀌는 모든 경로를 여기서 한 번에 처리)
            if self.main_seat is not None:
                self.seats[self.main_seat]["standby"] = False
            st = self.public_state()
        self.emit("state", st)
        broadcast_rooms()

    # ----- 자리 / 역할 -----
    def is_worker(self, seat_id):
        return (seat_id is not None and self.seats[seat_id]["token"] is not None
                and self.seats[seat_id]["role"] == "worker")

    def workers_in_order(self):
        return sorted((s for s in self.seats if s["token"] and s["role"] == "worker"), key=lambda s: s["joined_at"])

    def worker_count(self):
        return len(self.workers_in_order())

    def other_worker(self, seat_id):
        for s in self.workers_in_order():
            if s["id"] != seat_id:
                return s["id"]
        return None

    def ensure_main(self):
        """턴 주인이 없거나 작업자가 아니면, 가장 먼저 온 작업자에게 턴을 줘요."""
        if self.is_worker(self.main_seat):
            return
        ws = self.workers_in_order()
        self.main_seat = ws[0]["id"] if ws else None

    def promote_spectators(self):
        """작업자 자리가 비면 가장 먼저 온 관전자를 작업자로 올려요."""
        while self.worker_count() < MAX_WORKERS:
            waiting = sorted(
                (s for s in self.seats if s["token"] and s["role"] == "spectator"),
                key=lambda s: s["joined_at"],
            )
            if not waiting:
                break
            waiting[0]["role"] = "worker"
            waiting[0]["ready"] = False

    def release_seat(self, seat_id):
        s = self.seats[seat_id]
        if s["sid"]:
            c = conns.get(s["sid"])
            if c and c["room"] == self.id and c["seat"] == seat_id:
                c["seat"] = None
        self.seats[seat_id] = _empty_seat(seat_id, s["name"])  # 이름은 남겨둬요
        self.clear_box(seat_id)
        self.promote_spectators()
        self.ensure_main()

    # ----- 입력칸 / 송출 -----
    def unsent_text(self, seat_id):
        return self.texts[seat_id][self.sent[seat_id]:]

    def history_chunk(self, region):
        """송출되는 구간 글 → 송출 이력에 붙일 글. 어절 사이는 띄어쓰기 하나, 줄바꿈은 그대로 한 번."""
        out = ""

        def at_line_start():
            tail = (self.history + out)[-1:]
            return tail == "" or tail == "\n"

        lead = re.match(r"\s*", region).group(0)
        if "\n" in lead and not at_line_start():
            out += "\n"
        for m in re.finditer(r"(\S+)(\s*)", region):
            out += m.group(1) if at_line_start() else " " + m.group(1)
            if "\n" in m.group(2):
                out += "\n"
        return out

    def trim_sent(self, seat_id):
        """송출된 부분이 TRIM_AT 이상이면 앞쪽을 어절 경계에서 잘라내고 방 사람들에게 알려요."""
        S = self.sent[seat_id]
        if S < TRIM_AT:
            return
        T = self.texts[seat_id]
        k = S - TRIM_KEEP
        while k < S and not T[k - 1].isspace():
            k += 1
        if k <= 0:
            return
        removed = T[:k]
        self.texts[seat_id] = T[k:]
        self.sent[seat_id] = S - k
        self.ext_ver[seat_id] += 1
        ops = self.ext_ops[seat_id]
        ops.append((self.ext_ver[seat_id], removed))
        del ops[:-OPS_KEEP]
        self.emit("cut", {
            "seat": seat_id,
            "removed": removed,
            "ext": self.ext_ver[seat_id],
            "text": self.texts[seat_id],
            "sent": self.sent[seat_id],
        })

    def clear_box(self, seat_id, skip_sid=None):
        """칸 내용·송출 위치·노란 창·잘라내기 기록을 비우고 방 사람들에게 알려요."""
        self.texts[seat_id] = ""
        self.sent[seat_id] = 0
        self.ext_ops[seat_id] = []
        self.seats[seat_id]["standby"] = False
        self.emit("text", {"seat": seat_id, "text": "", "sent": 0, "ext": self.ext_ver[seat_id], "reset": True},
                  skip_sid=skip_sid)

    def texts_payload(self):
        return {
            s["id"]: {"text": self.texts[s["id"]], "ext": self.ext_ver[s["id"]], "sent": self.sent[s["id"]]}
            for s in self.workers_in_order()
        }

    def video_msg(self, by=None):
        return {"video": dict(self.video) if self.video else None, "now": time.time(), "by": by}


def _load_room_names():
    raw = _load_json(ROOMS_FILE)
    return {str(k): v for k, v in raw.items() if isinstance(v, str)} if isinstance(raw, dict) else {}


_room_names = _load_room_names()
rooms = {i: Room(i, clean_name(_room_names.get(str(i)), ROOM_NAME_MAX)) for i in range(1, NUM_ROOMS + 1)}

# 연결별: 보고 있는 방 번호(room)와 그 방에서 앉은 자리(seat). 방 목록 화면이면 room=None.
conns = {}
_last_rooms_summary = None


def rooms_summary():
    return [r.summary() for r in rooms.values()]


def broadcast_rooms(force=False):
    """방 목록 요약(이름·인원)을 모두에게. 바뀌었을 때만 보내요."""
    global _last_rooms_summary
    with lock:
        summ = rooms_summary()
        if not force and summ == _last_rooms_summary:
            return
        _last_rooms_summary = summ
    socketio.emit("rooms", summ)


def get_room(raw):
    try:
        return rooms.get(int(raw))
    except (TypeError, ValueError):
        return None


def conn():
    return conns.setdefault(request.sid, {"room": None, "seat": None})


def watch(room):
    """이 연결이 room을 보도록(그 방 이벤트를 받도록) Socket.IO room을 옮겨요. lock 안에서 호출."""
    c = conn()
    if c["room"] == room.id:
        return
    if c["room"] is not None:
        leave_room(rooms[c["room"]].channel)
    c["room"], c["seat"] = room.id, None
    join_room(room.channel)


def ctx():
    """(지금 연결이 보고 있는 방, 그 방에서 앉은 자리 번호 또는 None). 방을 안 보면 (None, None)."""
    c = conns.get(request.sid)
    if not c or c["room"] is None:
        return None, None
    room = rooms[c["room"]]
    seat_id = c["seat"]
    if seat_id is None or room.seats[seat_id]["sid"] != request.sid:
        return room, None
    return room, seat_id


def release_if_still_offline(room, seat_id, token):
    with lock:
        s = room.seats[seat_id]
        if s["token"] != token or s["online"]:
            return
        room.release_seat(seat_id)
    room.broadcast()


# ---------- 화면 ----------

# ---------- 버전 (배포 후 옛 화면 방지) ----------
# 파일 "내용"의 해시를 버전으로 써요. (배포 환경은 파일 수정시각을 고정값으로 바꿔버리기도 해서 시각보다 안전해요)
# - 정적 파일 주소에 ?v=<그 파일 해시> → 내용이 바뀌면 주소가 바뀌어 브라우저가 반드시 새로 받아요.
# - APP_VERSION(서버·화면 파일 전체 해시)을 페이지에 심고, 연결/재연결 때마다 "hello"로도 보내요.
#   열려 있던 탭은 둘이 다르면 "새 버전이 있어요. 새로고침" 안내를 띄워요.
_hash_cache = {}   # 경로 → (수정시각, 해시)  — 내용이 바뀌었을 때만 다시 계산


def _file_hash(path):
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return "0"
    hit = _hash_cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    try:
        with open(path, "rb") as f:
            h = hashlib.md5(f.read()).hexdigest()[:10]
    except OSError:
        return "0"
    _hash_cache[path] = (mtime, h)
    return h


_VERSION_FILES = [
    os.path.abspath(__file__),
    os.path.join(app.root_path, "templates", "index.html"),
    os.path.join(app.static_folder, "live.js"),
    os.path.join(app.static_folder, "live.css"),
    os.path.join(app.static_folder, "socket.io.min.js"),
]


def app_version():
    return hashlib.md5("".join(_file_hash(p) for p in _VERSION_FILES).encode()).hexdigest()[:10]


@app.context_processor
def _asset_version():
    def asset_v(filename):
        return _file_hash(os.path.join(app.static_folder, filename))
    return {"asset_v": asset_v, "app_version": app_version()}


def _page():
    resp = make_response(render_template("index.html"))
    resp.headers["Cache-Control"] = "no-cache"  # 페이지(HTML)는 항상 서버에 확인 → 새 버전 주소를 받게
    return resp


@app.route("/")
def index():
    return _page()


@app.route("/room/<int:rid>")
def room_page(rid):
    if rid not in rooms:
        return redirect("/")
    return _page()


@app.route("/health")
def health():
    return {"ok": True}


# ---------- 실시간 이벤트: 방 목록 / 방 보기 ----------

@socketio.on("connect")
def on_connect():
    with lock:
        conns[request.sid] = {"room": None, "seat": None}
        summ = rooms_summary()
    emit("hello", {"version": app_version()})  # 열려 있던 탭이 서버 새 버전을 알아채게
    emit("rooms", summ)


@socketio.on("watch")
def on_watch(data):
    """방 카드를 누름(또는 /room/N 주소로 들어옴) → 그 방의 자리 화면을 봐요. {room}
    없는 방이면 watch_error(code=no_room) → 브라우저가 조용히 방 목록으로 가요."""
    room = get_room((data or {}).get("room"))
    if room is None:
        return emit("watch_error", {"code": "no_room"})
    with lock:
        _room, seat_id = ctx()
        if seat_id is not None and _room is not room:
            return emit("toast", {"message": "지금 방에서 먼저 나가주세요."})
        watch(room)
        st = room.public_state()
    emit("state", st)


@socketio.on("unwatch")
def on_unwatch():
    """방 목록으로 돌아감. 자리에 앉아 있으면 안 돼요 (먼저 나가기)."""
    with lock:
        room, seat_id = ctx()
        if room is None:
            return
        if seat_id is not None:
            return emit("toast", {"message": "자리에서 먼저 나가주세요."})
        leave_room(room.channel)
        conns[request.sid] = {"room": None, "seat": None}
        summ = rooms_summary()
    emit("rooms", summ)


@socketio.on("rename_room")
def on_rename_room(data):
    """방 카드의 ✏️ → 방 이름 바꾸기 (예: "SBS 뉴스"). {room, name}"""
    data = data or {}
    room = get_room(data.get("room"))
    name = clean_name(data.get("name"), ROOM_NAME_MAX)
    if room is None:
        return emit("toast", {"message": "없는 방이에요."})
    if not name:
        return emit("toast", {"message": "방 이름을 입력해주세요."})
    with lock:
        room.name = name
        names = {str(r.id): r.name for r in rooms.values()}
    try:
        _save_json(ROOMS_FILE, names)
    except OSError as e:
        print(f"[rooms] 저장 실패: {e}", flush=True)
    room.broadcast()


# ---------- 실시간 이벤트: 입장 / 이름 / 나가기 ----------

@socketio.on("join")
def on_join(data):
    data = data or {}
    if "room" not in data:
        # 방이 하나이던 때의 옛 화면(배포 전부터 열려 있던 탭)이 재연결하며 보낸 입장 요청
        return emit("join_error", {"message": "새 버전이 배포됐어요. 새로고침(F5)해 주세요.",
                                   "clear": True, "code": "outdated"})
    room = get_room(data.get("room"))
    if room is None:
        return emit("join_error", {"message": "", "clear": True, "code": "no_room"})
    try:
        seat_id = int(data.get("seat"))
    except (TypeError, ValueError):
        return emit("join_error", {"message": "잘못된 자리예요.", "clear": True})
    if not 0 <= seat_id < MAX_SEATS:
        return emit("join_error", {"message": "잘못된 자리예요.", "clear": True})

    token = data.get("token")
    with lock:
        cur_room, cur_seat = ctx()
        if cur_seat is not None and (cur_room is not room or cur_seat != seat_id):
            return emit("join_error", {"message": "이미 다른 자리에 앉아 있어요. 먼저 나가주세요."})
        s = room.seats[seat_id]
        if s["token"] is not None:
            if token and token == s["token"]:
                # 새로고침/재연결 → 같은 방, 같은 자리로 복귀
                if s["sid"] and s["sid"] != request.sid:
                    old = conns.get(s["sid"])
                    if old and old["room"] == room.id and old["seat"] == seat_id:
                        old["seat"] = None
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
            s["role"] = "worker" if room.worker_count() < MAX_WORKERS else "spectator"
            room.texts[seat_id] = ""
            room.sent[seat_id] = 0
            room.ext_ops[seat_id] = []
            room.ensure_main()
        watch(room)
        conn()["seat"] = seat_id
        payload_name = s["name"]
        payload = {
            "room": room.id,
            "seat": seat_id,
            "token": s["token"],
            "texts": room.texts_payload(),
            # 재연결(새로고침 아님) 시 끊긴 동안 친 글을 살리면서 놓친 잘라내기를 적용하려고 보내요
            "my_ops": [[v, r] for v, r in room.ext_ops[seat_id]],
            "history": room.history,
            "video": room.video_msg(),
        }

    emit("joined", payload)
    emit("snippets", snippets_payload(payload_name))
    room.broadcast()


@socketio.on("rename")
def on_rename(data):
    """자리 이름 바꾸기 (보고 있는 방의 자리). {seat, name}"""
    data = data or {}
    try:
        seat_id = int(data.get("seat"))
    except (TypeError, ValueError):
        return
    name = clean_name(data.get("name"))
    if not name or not 0 <= seat_id < MAX_SEATS:
        return emit("toast", {"message": "이름을 입력해주세요."})
    with lock:
        room, my_seat_id = ctx()
        if room is None:
            return
        s = room.seats[seat_id]
        mine = my_seat_id == seat_id
        if s["token"] is not None and not mine:
            return emit("toast", {"message": "다른 사람이 쓰고 있는 자리는 이름을 바꿀 수 없어요."})
        s["name"] = name
        sid = s["sid"] if mine else None
    if sid:
        socketio.emit("snippets", snippets_payload(name), to=sid)  # 이름이 바뀌면 그 이름의 상용구로
    room.broadcast()


@socketio.on("leave")
def on_leave():
    with lock:
        room, seat_id = ctx()
        if seat_id is None:
            return
        room.release_seat(seat_id)  # 방은 계속 보고 있어요 → 그 방의 자리 화면으로
    emit("left")
    room.broadcast()


@socketio.on("disconnect")
def on_disconnect(*_args):
    with lock:
        room, seat_id = ctx()
        conns.pop(request.sid, None)
        if seat_id is None:
            return
        s = room.seats[seat_id]
        s["online"] = False
        s["sid"] = None
        token = s["token"]
    t = threading.Timer(GRACE_SECONDS, release_if_still_offline, args=(room, seat_id, token))
    t.daemon = True
    t.start()
    room.broadcast()


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
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return
        if known < room.ext_ver[seat_id]:
            # 작업자가 아직 모르는 정리(앞부분 잘라내기)를 그 글에도 똑같이 적용
            for ver, removed in room.ext_ops[seat_id]:
                if ver > known and text.startswith(removed):
                    text = text[len(removed):]
        prefix = room.texts[seat_id][:room.sent[seat_id]]
        if not text.startswith(prefix):
            # 송출된 부분이 바뀐 글 → 받지 않고 주인 브라우저를 서버 글로 맞춰요 (정상이라면 일어나지 않아요)
            return emit("resync", {"text": room.texts[seat_id], "sent": room.sent[seat_id],
                                   "ext": room.ext_ver[seat_id]})
        room.texts[seat_id] = text
        room.emit("text", {"seat": seat_id, "text": text, "sent": room.sent[seat_id], "ext": room.ext_ver[seat_id]},
                  skip_sid=request.sid)
        # 노란 창이 켜진 대기 작업자가 글을 지워 칸이 비거나 공백만 남으면 노란 창을 꺼요
        standby_off = room.seats[seat_id]["standby"] and not text.strip()
        if standby_off:
            room.seats[seat_id]["standby"] = False
    if standby_off:
        room.broadcast()


@socketio.on("standby")
def on_standby():
    """대기 작업자가 자기 칸에서 Enter → 칸 전체가 노란 창 (이어받을 준비 됐다는 신호).
    칸이 비어 있거나 공백만 있으면 켜지 않아요 (글을 지우면 on_text에서 자동으로 꺼져요)."""
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id) or seat_id == room.main_seat:
            return
        if room.seats[seat_id]["standby"] or not room.texts[seat_id].strip():
            return
        room.seats[seat_id]["standby"] = True
    room.broadcast()


@socketio.on("clear_mine")
def on_clear_mine():
    """F12 / 턴 넘기기: 내 칸 전체 지우기 + 송출 위치 초기화 + 노란 창 끄기. 응답: {ok, ext}"""
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return {"ok": False}
        room.ext_ver[seat_id] += 1  # 그 전에 보낸 정리(잘라내기)는 지운 칸에 적용하지 않게
        room.clear_box(seat_id, skip_sid=request.sid)  # 주인 칸은 이미 비웠어요 (그 뒤 친 글을 지우지 않게)
        ext = room.ext_ver[seat_id]
    room.broadcast()
    return {"ok": True, "ext": ext}


@socketio.on("pass_turn")
def on_pass_turn():
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id) or seat_id != room.main_seat:
            return emit("toast", {"message": "작성중일 때만 턴을 넘길 수 있어요."})
        other = room.other_worker(seat_id)
        if other is None:
            return emit("toast", {"message": "턴을 넘길 상대 작업자가 없어요."})
        room.main_seat = other
        other_sid = room.seats[other]["sid"]
        my_name = room.seats[seat_id]["name"]
    if other_sid:
        socketio.emit("toast", {"message": f"{my_name}님이 턴을 넘겼어요. 이제 작성중이에요."}, to=other_sid)
    room.broadcast()


# ---------- 실시간 이벤트: 대기열 초록불 / 자리 교체 ----------

@socketio.on("toggle_ready")
def on_toggle_ready():
    """관전자가 자기 칩을 눌러 초록불을 켜고 꺼요."""
    with lock:
        room, seat_id = ctx()
        if seat_id is None or room.seats[seat_id]["role"] != "spectator":
            return emit("toast", {"message": "관전자만 자기 초록불을 켤 수 있어요."})
        room.seats[seat_id]["ready"] = not room.seats[seat_id]["ready"]
    room.broadcast()


@socketio.on("swap")
def on_swap(data):
    """작업자가 초록불 켜진 관전자 칩(같은 방)을 눌러 자리를 바꿔요. {target, confirm}"""
    data = data or {}
    try:
        target = int(data.get("target"))
    except (TypeError, ValueError):
        return
    confirm = bool(data.get("confirm"))
    with lock:
        room, me_id = ctx()
        if room is None or not room.is_worker(me_id):
            return emit("toast", {"message": "작업자만 자리를 바꿀 수 있어요."})
        if not 0 <= target < MAX_SEATS:
            return
        t = room.seats[target]
        if t["token"] is None or t["role"] != "spectator" or not t["ready"]:
            return  # 초록불이 꺼진 칩(또는 이미 바뀐 자리) → 아무 일 없음
        if not t["online"]:
            return emit("toast", {"message": f"{t['name']}님이 연결 끊김 상태라 바꿀 수 없어요."})
        if room.unsent_text(me_id).strip() and not confirm:
            return emit("swap_confirm", {"target": target})

        w = room.seats[me_id]
        # 관전자는 작업자의 자리 순서를 그대로 이어받고, 작업자는 대기열 맨 뒤로
        t["joined_at"], w["joined_at"] = w["joined_at"], time.time()
        t["role"], w["role"] = "worker", "spectator"
        t["ready"] = w["ready"] = False
        if room.main_seat == me_id:
            room.main_seat = target
        for sid_ in (me_id, target):  # 두 칸 모두 빈 칸으로 새로 시작 (작업자의 남은 글은 삭제)
            room.clear_box(sid_)
        target_sid = t["sid"]
        msg = f"{w['name']}님과 자리를 바꿨어요. 이제 작업자예요" + (" (작성중)." if room.main_seat == target else ".")
    socketio.emit("toast", {"message": msg}, to=target_sid)
    emit("toast", {"message": f"{t['name']}님과 자리를 바꿨어요. 이제 관전자예요."})
    room.broadcast()


# ---------- 실시간 이벤트: 송출 / 상대 칸 삭제 / 이력 ----------

@socketio.on("send_upto")
def on_send_upto(data):
    """작성중 작업자의 칸에서 [sent, offset) 구간을 송출해요. {offset, ext}
    자동 송출(완성 어절 3개 → 맨 앞 1개), F1(첫 어절), Insert(남은 글 전부)가 모두 이걸 써요.
    응답: {ok, sent, ext, message?} — sent/ext는 서버 기준 최신 값"""
    data = data or {}
    try:
        offset = int(data.get("offset"))
        known = int(data.get("ext", 0))
    except (TypeError, ValueError):
        return {"ok": False, "sent": 0, "ext": 0}
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return {"ok": False, "sent": 0, "ext": 0, "message": "작업자만 송출할 수 있어요."}

        def result(ok, message=None):
            r = {"ok": ok, "sent": room.sent[seat_id], "ext": room.ext_ver[seat_id]}
            if message:
                r["message"] = message
            return r

        if seat_id != room.main_seat:
            return result(False, "작성중인 작업자만 송출할 수 있어요. (지금은 대기중)")
        if known < room.ext_ver[seat_id]:
            # 옛 버전 기준 위치 → 그 뒤 정리로 잘린 만큼 당겨서 해석
            ops = [r for v, r in room.ext_ops[seat_id] if v > known]
            if len(ops) != room.ext_ver[seat_id] - known:
                return result(False)
            offset -= sum(len(r) for r in ops)
        S, T = room.sent[seat_id], room.texts[seat_id]
        if offset <= S:
            return result(True)  # 이미 송출됨 (같은 요청이 두 번 와도 한 번만)
        if offset > len(T) or not (offset == len(T) or T[offset - 1].isspace()):
            return result(False)
        chunk = room.history_chunk(T[S:offset])
        room.sent[seat_id] = offset
        if chunk:
            room.history += chunk
            room.emit("history_append", {"chunk": chunk})
        room.emit("sent", {"seat": seat_id, "sent": offset, "ext": room.ext_ver[seat_id]}, skip_sid=request.sid)
        room.trim_sent(seat_id)
        return result(True)


@socketio.on("delete_partner_word")
def on_delete_partner_word():
    """F8: 같은 방 상대 작업자 칸의 '송출 안 된 첫 어절'을 지워요. 상대 브라우저가 직접 지우도록 전달."""
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return emit("toast", {"message": "작업자만 상대 칸을 지울 수 있어요."})
        other = room.other_worker(seat_id)
        if other is None:
            return emit("toast", {"message": "상대 작업자가 없어요."})
        if not FIRST_WORD.match(room.unsent_text(other)):
            return emit("toast", {"message": "상대 칸에 지울 내용이 없어요. (송출된 글은 지울 수 없어요)"})
        other_sid = room.seats[other]["sid"]
        if not other_sid:
            return emit("toast", {"message": "상대가 연결 끊김 상태라 지울 수 없어요."})
    socketio.emit("delete_first", {}, to=other_sid)


@socketio.on("clear_history")
def on_clear_history():
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return emit("toast", {"message": "작업자만 송출 이력을 초기화할 수 있어요."})
        room.history = ""
        room.emit("history_full", {"history": ""})
    emit("toast", {"message": "송출 이력을 초기화했어요."})


# ---------- 실시간 이벤트: 영상 같이 보기 (방마다 따로) ----------
# 지금 위치 = playing이면 pos + (지금 - at), 아니면 pos. 나중에 들어온 사람도 이걸로 현재 위치부터 봐요.

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
    """작업자가 유튜브 영상을 열어요 → 같은 방 모두의 화면에 같은 영상이 재생돼요. {id, start}"""
    data = data or {}
    vid = data.get("id")
    start = _clean_pos(data.get("start", 0)) or 0.0
    if not isinstance(vid, str) or not YT_ID.match(vid):
        return emit("toast", {"message": "유튜브 영상 ID가 잘못됐어요."})
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return emit("toast", {"message": "영상은 작업자만 열 수 있어요."})
        room.video = {"id": vid, "playing": True, "pos": start, "at": time.time()}
        msg = room.video_msg(room.seats[seat_id]["name"])
    room.emit("video", msg)


@socketio.on("video_ctrl")
def on_video_ctrl(data):
    """작업자의 재생/일시정지/시간 이동 → 같은 방 모두에게. {action: play|pause|seek, pos: 그 순간 영상 시간}"""
    data = data or {}
    action = data.get("action")
    pos = _clean_pos(data.get("pos"))
    if action not in ("play", "pause", "seek") or pos is None:
        return
    with lock:
        room, seat_id = ctx()
        if room is None or not room.is_worker(seat_id):
            return emit("toast", {"message": "영상 조작은 작업자만 할 수 있어요."})
        if room.video is None:
            return
        if action != "seek":
            room.video["playing"] = action == "play"
        room.video["pos"] = pos
        room.video["at"] = time.time()
        msg = room.video_msg(room.seats[seat_id]["name"])
    room.emit("video", msg)


# ---------- 실시간 이벤트: 상용구 (작업자 이름별, 방과 상관없이) ----------
# 이름은 브라우저가 보낸 값이 아니라 "지금 이 연결이 앉은 자리의 이름"을 써요 → 다른 작업자 것과 섞이지 않아요.

def snippets_payload(name):
    with snip_lock:
        return {"name": name, "items": dict(snippets.get(name, {}))}


def my_name():
    with lock:
        room, seat_id = ctx()
        return None if seat_id is None else room.seats[seat_id]["name"]


def push_snippets(name):
    """같은 이름으로 앉아 있는 모든 연결(다른 방·다른 탭 포함)에 최신 목록을 보내요."""
    payload = snippets_payload(name)
    with lock:
        sids = [s["sid"] for r in rooms.values() for s in r.seats if s["token"] and s["sid"] and s["name"] == name]
    for sid in sids:
        socketio.emit("snippets", payload, to=sid)


@socketio.on("snippets_get")
def on_snippets_get():
    """내 상용구 목록을 다시 보내요. 응답(ack)으로도 같은 목록을 돌려줘요 (등록 결과 확인용)."""
    name = my_name()
    if name is None:
        return {"name": None, "items": {}}
    payload = snippets_payload(name)
    emit("snippets", payload)
    return payload


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
