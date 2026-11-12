// 실시간 방송 자막 — 화면 로직 (입장 / 입력 공유 / 턴 / 자동 송출 / 단축키)
const socket = io();
const STORE_KEY = "live_me";

let state = null;          // 서버가 보내주는 "지금 보고 있는 방"의 전체 상태
let me = loadMe();         // { room, seat, token } — 새로고침해도 같은 방·같은 자리로 복귀
let joined = false;        // 서버가 입장을 확인했는지
let editingSeat = null;    // 방 입장 화면에서 이름 수정 중인 자리
let currentRoom = roomFromPath(); // 주소 /room/N 의 N (방 목록 화면이면 null)
let roomsList = [];        // 방 목록 요약 [{ id, name, workers, spectators, ... }]
let editingRoom = null;    // 방 목록에서 이름 수정 중인 방

function roomFromPath() {
  const m = location.pathname.match(/^\/room\/(\d+)\/?$/);
  return m ? Number(m[1]) : null;
}

// 입력칸 / 송출 이력
const boxes = new Map();   // 자리 번호 → textarea (한 번 만들면 계속 재사용 → 커서·조합 유지)
const texts = {};          // 자리 번호 → 서버가 알려준 글 (상대·관전용 표시)
const sents = {};          // 자리 번호 → 서버가 알려준 송출 위치 (앞에서 몇 글자가 송출됐는지)
const exts = {};           // 자리 번호 → 서버가 알려준 정리(잘라내기) 버전
let myExt = 0;             // 내 칸에 대해 서버가 정리한 버전 중 내가 반영한 마지막 번호
let mySent = 0;            // 내 칸의 송출 위치 (송출 요청을 보낸 곳까지 — 이 앞은 고칠 수 없음)
let pendingOps = [];       // 한글 조합 중이라 아직 반영 못 한 정리(앞부분 잘라내기)
let afterIme = [];         // 한글 조합이 끝나면 할 일 (상대의 F8 삭제 등)
let clearPending = false;  // F12 직후 서버 확인 전 — 그 전에 온 정리는 지운 칸에 적용 안 함
let composing = false;     // 내 칸에서 한글 조합 중인지
let historyText = "";
let lastValue = "";        // 마지막으로 서버에 보낸(= 송출된 부분이 온전한) 내 칸 글
let boxGen = 0;            // 내 칸을 통째로 비울 때마다 +1 (그 전에 보낸 송출 요청의 응답을 버리려고)

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const roleText = (r) => (r === "worker" ? "작업자" : r === "spectator" ? "관전자" : "");
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30;

function loadMe() {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE_KEY));
    return v && typeof v.room === "number" ? v : null; // 방이 하나이던 때 저장한 값은 버려요
  } catch { return null; }
}
function saveMe(v) {
  me = v;
  if (v) sessionStorage.setItem(STORE_KEY, JSON.stringify(v));
  else sessionStorage.removeItem(STORE_KEY);
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ---------- 내 위치 도우미 ----------
const myInfo = () => (state && me ? state.seats[me.seat] : null);
const amWorker = () => { const m = myInfo(); return !!(joined && m && m.taken && m.role === "worker"); };
const amMain = () => amWorker() && state.main_seat === me.seat;
const myBox = () => (me ? boxes.get(me.seat) : null);
const partnerSeat = () => {
  if (!state || !me) return null;
  const p = state.seats.find((s) => s.taken && s.role === "worker" && s.id !== me.seat);
  return p ? p.id : null;
};

function clearObj(o) { for (const k of Object.keys(o)) delete o[k]; }

function resetRoomLocal() {
  boxes.clear();
  clearObj(texts); clearObj(sents); clearObj(exts);
  lastValue = "";
  myExt = 0;
  mySent = 0;
  pendingOps = [];
  afterIme = [];
  clearPending = false;
  composing = false;
  reinsertGuard = null;
  phrases = Object.create(null);
  phraseOwner = null;
  for (let i = 0; i < 2; i++) { const el = $(`writer-${i}`); if (el) { delete el.dataset.seat; el.innerHTML = ""; } }
}

// ---------- 서버 이벤트 ----------
// (재)연결되면 주소의 방을 다시 보고, 그 방에 내 자리가 있으면 다시 앉아요 (새로고침 → 같은 방, 같은 자리)
socket.on("connect", () => {
  $("conn").classList.add("hidden");
  enterRoute();
});
function enterRoute() {
  if (currentRoom === null) return render();
  if (me && me.room !== currentRoom) saveMe(null); // 다른 방 자리 정보 → 이 방에선 못 써요
  socket.emit("watch", { room: currentRoom });
  if (me) socket.emit("join", { room: currentRoom, seat: me.seat, token: me.token });
}
socket.on("disconnect", () => $("conn").classList.remove("hidden"));
socket.on("state", (s) => {
  if (s.room !== currentRoom) return; // 방을 옮긴 직후 늦게 온 이전 방 상태는 무시
  state = s;
  render();
});
socket.on("rooms", (list) => {
  roomsList = Array.isArray(list) ? list : [];
  if (currentRoom === null) renderRooms();
});
socket.on("joined", (d) => {
  if (d.room !== currentRoom) return;
  const localBox = boxes.get(d.seat); // 있으면: 새로고침이 아니라 잠깐 끊겼다 재연결된 것
  saveMe({ room: d.room, seat: d.seat, token: d.token });
  joined = true;

  clearObj(texts); clearObj(sents); clearObj(exts);
  for (const [seat, t] of Object.entries(d.texts || {})) { texts[seat] = t.text; sents[seat] = t.sent || 0; exts[seat] = t.ext || 0; }
  const mine = (d.texts || {})[d.seat];
  clearPending = false;
  if (mine && localBox) {
    // 끊긴 동안 친 글은 살리고, 그동안 서버가 정리한 것만 똑같이 반영한 뒤 서버로 다시 보내요
    pendingOps = (d.my_ops || []).map(([ext, removed]) => ({ ext, removed, text: mine.text, sent: mine.sent }));
    applyPendingOps(true);
    myExt = Math.max(myExt, mine.ext);
    if (mySent > mine.sent) {
      // 끊기기 직전에 보낸 송출 요청이 서버에 닿지 않았음 → 다시 요청 (턴이 없으면 서버가 거절 → 원래대로)
      const want = mySent;
      mySent = mine.sent;
      requestSend(want);
    } else {
      mySent = mine.sent;
    }
    paintBox(d.seat);
  } else if (mine) {
    myExt = mine.ext; // 새로고침 → 서버에 남아 있던 글·송출 위치로 칸을 채워요 (render → getBox에서)
    mySent = mine.sent;
  }
  for (const [seat, ta] of boxes) if (Number(seat) !== d.seat) setBoxText(ta, texts[seat] || "");

  setHistory(d.history || "");
  render();
  applyVideo(d.video);
});
socket.on("join_error", (d) => {
  if (d.clear) { saveMe(null); joined = false; resetRoomLocal(); teardownVideo(); }
  toast(d.message);
  render();
});
socket.on("left", () => { saveMe(null); joined = false; resetRoomLocal(); teardownVideo(); render(); });
socket.on("toast", (d) => toast(d.message));

const isMyLiveBox = (seat) => joined && me && seat === me.seat && myBox();

// 다른 작업자가 입력한 글 (자기 칸 글은 서버가 나에게 다시 보내지 않아요)
socket.on("text", (d) => {
  if (isMyLiveBox(d.seat)) {
    if (!d.reset) return;
    // 서버가 내 칸을 비움 (자리 교체 등)
    boxGen++;
    setMyValue(myBox(), "", 0);
    mySent = 0;
    myExt = d.ext || myExt;
    pendingOps = [];
    lastValue = "";
    paintBox(me.seat);
    return;
  }
  texts[d.seat] = d.text;
  sents[d.seat] = d.sent || 0;
  if (d.ext != null) exts[d.seat] = d.ext;
  const ta = boxes.get(d.seat);
  if (ta) setBoxText(ta, d.text);
});

// 다른 작업자 칸의 송출 위치가 옮겨짐 (파란 배경만 다시 그림)
socket.on("sent", (d) => {
  if (isMyLiveBox(d.seat)) return;
  sents[d.seat] = d.sent || 0;
  paintBox(d.seat);
});

// 서버가 어떤 칸의 송출된 앞부분을 정리함 (길어져서)
socket.on("cut", (d) => {
  if (isMyLiveBox(d.seat)) {
    if (clearPending) return; // F12로 지우기 전 글에 대한 정리 → 무시
    pendingOps.push(d);
    if (!composing) applyPendingOps();
    return;
  }
  texts[d.seat] = d.text;
  sents[d.seat] = d.sent || 0;
  exts[d.seat] = d.ext;
  const ta = boxes.get(d.seat);
  if (ta) setBoxText(ta, d.text);
});

// 내 칸 글이 서버와 어긋남 (송출된 부분이 바뀐 글을 보냄) → 서버 글로 맞춤
socket.on("resync", (d) => {
  const ta = myBox();
  if (!ta) return;
  boxGen++;
  pendingOps = [];
  myExt = d.ext;
  mySent = d.sent;
  setMyValue(ta, d.text, d.text.length);
  lastValue = d.text;
  paintBox(me.seat);
});

// 상대 작업자가 F8 → 내 칸의 "송출 안 된 첫 어절"을 지움
socket.on("delete_first", () => whenImeIdle(deleteFirstUnsent));

socket.on("history_append", (d) => appendHistory(d.chunk));
socket.on("history_full", (d) => setHistory(d.history || ""));

// ---------- 입력칸 ----------
// 내 칸 글이 바뀔 때마다 호출: 서버로 보내고, 작성중이면 자동 송출을 확인해요.
function emitText() {
  const ta = myBox();
  if (!ta) return;
  const v = ta.value;
  if (!v.startsWith(lastValue.slice(0, mySent))) {
    // 송출된 부분이 바뀜 → 되돌리고(친 글자는 송출 안 된 부분 끝에 붙여서) 다시 보냄
    if (!composing) repairSent(ta);
    return;
  }
  lastValue = v;
  paintBox(me.seat);
  socket.emit("text", { text: v, ext: myExt });
  maybeAutoSend();
}

function onMyInput(e) {
  const ta = e.currentTarget;
  if (!e.isComposing && checkReinsert(ta)) return;
  emitText();
  // 대기중 작업자가 Enter → 내 칸 전체가 노란 창 (이어받을 준비 신호). 칸이 비었거나 공백뿐이면 안 켜요.
  // (켜진 뒤 글을 지워 비거나 공백만 남으면 서버가 자동으로 꺼요 — 다시 쓰고 Enter 치면 다시 켜짐)
  if (e.inputType === "insertLineBreak" && amWorker() && !amMain() && !(myInfo() || {}).standby && ta.value.trim()) {
    socket.emit("standby");
  }
}

// 내 칸 글을 코드로 바꿀 때 (스크롤 유지, 커서 위치 지정)
function setMyValue(ta, value, cursor) {
  const top = ta.scrollTop;
  ta.value = value;
  const c = Math.min(cursor, value.length);
  ta.setSelectionRange(c, c);
  ta.scrollTop = top;
}

// ---------- 송출된 부분 보호 ----------
// 송출된 부분 앞/안에 커서를 두고 치면 → 커서를 송출 안 된 부분 끝으로 옮긴 뒤 그 자리에 입력돼요.
// Backspace/Delete가 송출된 글자를 건드리면 → 무시. (붙여넣기·잘라내기 등 나머지는 repairSent가 되돌려요)
function guardSentKeydown(e, ta) {
  if (!mySent || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = ta.selectionStart, en = ta.selectionEnd;
  if (s >= mySent) return;
  const k = e.key;
  if (k === "Backspace" || k === "Delete") {
    if (en > mySent && s !== en) ta.setSelectionRange(mySent, en); // 송출 안 된 부분만 지움
    else e.preventDefault();
    return;
  }
  const typing = k === "Enter" || k === "Process" || e.keyCode === 229 || (k && k.length === 1);
  if (!typing) return; // 화살표·Home 등 이동은 그대로
  if (en > mySent) ta.setSelectionRange(mySent, en);
  else ta.setSelectionRange(ta.value.length, ta.value.length);
}
// Backspace는 커서가 송출 위치 "바로 뒤"여도 송출된 글자를 지우므로 따로 확인
function guardBackspaceAtEdge(e, ta) {
  if (!mySent || e.key !== "Backspace") return;
  const s = ta.selectionStart, en = ta.selectionEnd;
  if (s === en && s === mySent) e.preventDefault();
}

// 송출된 부분이 바뀐 경우: 바뀌기 전 글로 되돌리고, 새로 들어온 글자는 송출 안 된 부분 끝에 붙여요.
function repairSent(ta) {
  const oldV = lastValue, v = ta.value;
  let p = 0;
  const max = Math.min(oldV.length, v.length);
  while (p < max && oldV[p] === v[p]) p++;
  let sfx = 0;
  while (sfx < max - p && oldV[oldV.length - 1 - sfx] === v[v.length - 1 - sfx]) sfx++;
  const inserted = v.slice(p, v.length - sfx);
  const fixed = oldV + inserted;
  setMyValue(ta, fixed, fixed.length);
  if (ta.value.startsWith(oldV.slice(0, mySent))) emitText();
}

// ---------- 자동 송출 / 송출 요청 ----------
// 상용구 등록 줄(입력어:출력어)을 치는 중이면 그 줄은 자동 송출하지 않아요 (F10 전에 송출되면 안 되니까).
const PHRASE_LINE = /^\s*[^:：\s]+\s*[:：]/;

// 작성중일 때, 송출 안 된 "완성 어절"(뒤에 공백·줄바꿈이 있는 어절)이 3개 이상이면
// 뒤쪽 2개만 남기고 앞에서부터 송출해요. 지금 치고 있는 마지막 어절(뒤에 공백 없음)은 세지 않아요.
function maybeAutoSend() {
  const ta = myBox();
  if (!ta || !amMain() || !socket.connected || clearPending || turnPassing()) return;
  const v = ta.value;
  let limit = v.length;
  // 커서가 있는 줄이 상용구 등록 줄이면 그 줄 앞까지만 셈
  const caret = ta.selectionStart;
  const lineStart = v.lastIndexOf("\n", caret - 1) + 1;
  let lineEnd = v.indexOf("\n", caret);
  if (lineEnd === -1) lineEnd = v.length;
  if (lineStart >= mySent && PHRASE_LINE.test(v.slice(lineStart, lineEnd))) limit = lineStart;

  const unsent = v.slice(mySent, limit);
  const ends = [];
  const re = /\S+\s+/g;
  let m;
  while ((m = re.exec(unsent))) ends.push(m.index + m[0].length);
  // limit에서 끊었으면 마지막 매치의 공백이 줄 경계라 완성 어절이 맞아요
  if (ends.length >= 3) requestSend(mySent + ends[ends.length - 3]);
}

// F1: 송출 안 된 첫 어절(치고 있던 어절이어도)을 바로 송출
function sendFirstWord(ta) {
  const m = /^\s*\S+\s*/.exec(ta.value.slice(mySent));
  if (!m) return toast("송출할 내용이 없어요.");
  requestSend(mySent + m[0].length);
}

// 서버에 "여기까지 송출" 요청. 바로 파랗게 칠하고(고칠 수 없게), 서버 응답으로 확정·보정해요.
function requestSend(offset) {
  const ta = myBox();
  if (!ta || offset <= mySent || offset > ta.value.length) return;
  mySent = offset;
  paintBox(me.seat);
  const gen = boxGen;
  socket.timeout(5000).emit("send_upto", { offset, ext: myExt }, (err, res) => {
    if (err || !res || myBox() !== ta) return; // 응답이 없으면 재연결 때 다시 맞춰요
    if (gen !== boxGen) return; // 그 사이 내 칸을 비웠음 (Insert/F12) → 옛 칸 기준 응답은 버려요
    // 서버 기준 위치 → 내 칸 기준 (아직 반영 못 한 정리만큼 더해서)
    let conv = res.sent;
    for (const op of pendingOps) if (op.ext > myExt && op.ext <= res.ext) conv += op.removed.length;
    if (res.ext < myExt) return; // 그 뒤 정리를 이미 반영함 → 다른 응답/이벤트가 맞춰요
    if (res.ok) mySent = Math.max(mySent, conv);
    else {
      mySent = Math.min(conv, ta.value.length);
      if (res.message) toast(res.message);
    }
    paintBox(me.seat);
    maybeAutoSend();
  });
}

// 작성중 → (Insert / 턴 넘기기 버튼) 순서대로:
//   1) 남은 송출 안 된 글(자동 송출 대기 어절 + 치고 있던 어절)을 전부 송출
//   2) 내 칸을 비우고 송출 위치 초기화 (서버가 다른 사람 화면에서도 비워요)
//   3) 상대에게 턴 넘김
// 서버는 한 사람이 보낸 이벤트를 보낸 순서대로 처리하므로 text → send_upto → clear_mine → pass_turn 순서가 지켜져요.
// 한글 조합 중에 누르면 onMyKeydown이 조합 확정 뒤로 미뤄서 부르므로, 조합 중이던 글자까지 들어간 값으로 처리돼요.
let passingUntil = 0;      // 턴을 넘기는 중 (서버 확인 전) — 중복 실행·자동 송출 막기
const turnPassing = () => Date.now() < passingUntil;

function passTurn() {
  if (!amMain()) return toast("작성중일 때만 턴을 넘길 수 있어요.");
  if (turnPassing()) return;
  if (!socket.connected) return toast("서버와 연결이 끊겨 있어요.");
  if (partnerSeat() === null) return toast("턴을 넘길 상대 작업자가 없어요.");
  const ta = myBox();
  if (ta) {
    emitText();                                                   // 마지막 입력을 서버에 먼저
    if (ta.value.slice(mySent).trim()) requestSend(ta.value.length); // 1) 남은 글 전부 송출
    clearMyBox(ta);                                               // 2) 칸 비우기 + 송출 위치 초기화
  }
  passingUntil = Date.now() + 3000;
  socket.emit("pass_turn");                                       // 3) 턴 넘김
}

// 내 칸 전체 + 송출 위치 초기화 (F12 / 턴 넘기기). 노란 창도 서버가 꺼요.
function clearMyBox(ta) {
  boxGen++;
  ta.value = "";
  lastValue = "";
  mySent = 0;
  pendingOps = [];
  clearPending = true;
  paintBox(me.seat);
  socket.timeout(5000).emit("clear_mine", (err, res) => {
    clearPending = false;
    if (!err && res && res.ok) myExt = Math.max(myExt, res.ext);
  });
}

// 상대의 F8: 내 칸의 송출 안 된 첫 어절(앞뒤 공백 포함)을 지움
function deleteFirstUnsent() {
  const ta = myBox();
  if (!ta) return;
  const v = ta.value;
  const m = /^\s*\S+\s*/.exec(v.slice(mySent));
  if (!m) return;
  const a = mySent, n = m[0].length;
  const fix = (x) => (x <= a ? x : x >= a + n ? x - n : a);
  const s = fix(ta.selectionStart), e = fix(ta.selectionEnd);
  const top = ta.scrollTop;
  ta.value = v.slice(0, a) + v.slice(a + n);
  ta.setSelectionRange(s, e);
  ta.scrollTop = top;
  emitText();
}

// 한글 조합 중이면 조합이 끝난 뒤에 실행 (조합 중에 칸을 고치면 글자가 꼬여요)
function whenImeIdle(fn) {
  if (!composing) return fn();
  afterIme.push(fn);
}

// ---------- 송출된 부분 표시 (파란 배경) ----------
// textarea 뒤 배경 레이어에 같은 글을 투명하게 그리고, 송출된 부분만 배경색을 입혀요.
function paintBox(seat) {
  const ta = boxes.get(Number(seat));
  if (!ta) return;
  const hl = ta.previousElementSibling;
  if (!hl || !hl.classList.contains("box-hl")) return;
  const isMine = joined && me && Number(seat) === me.seat;
  const v = ta.value;
  const n = Math.min(isMine ? mySent : (sents[seat] || 0), v.length);
  if (!n) {
    if (hl.firstChild) hl.textContent = "";
    return;
  }
  hl.innerHTML = `<span class="sent">${esc(v.slice(0, n))}</span>${esc(v.slice(n))}&#8203;`;
  if (ta.clientWidth) hl.style.width = ta.clientWidth + "px"; // 세로 스크롤바 폭을 빼서 줄바꿈 위치를 맞춤
  hl.scrollTop = ta.scrollTop;
}

// 상대·관전용(읽기 전용) 칸 갱신: 맨 아래를 보고 있었으면 계속 맨 아래로
function setBoxText(ta, text) {
  if (ta.value !== text) {
    const stick = nearBottom(ta);
    const top = ta.scrollTop;
    ta.value = text;
    ta.scrollTop = stick ? ta.scrollHeight : top;
  }
  paintBox(ta.dataset.seat);
}

// 내 칸에 서버의 정리(송출된 앞부분 잘라내기)를 반영 — 커서·송출 위치는 잘린 만큼 앞으로
function applyPendingOps(force = false) {
  const ta = myBox();
  if (!ta) { pendingOps = []; return; }
  const ops = pendingOps.filter((op) => op.ext > myExt).sort((a, b) => a.ext - b.ext);
  pendingOps = [];
  if (!ops.length && !force) return;

  let val = ta.value;
  let s = ta.selectionStart, e = ta.selectionEnd;
  for (const op of ops) {
    const n = op.removed.length;
    if (val.startsWith(op.removed) && n <= mySent) {
      val = val.slice(n);
      mySent -= n;
      s = Math.max(0, s - n);
      e = Math.max(0, e - n);
    } else {
      val = op.text; // 앞부분이 달라졌으면 서버 글을 따름
      mySent = op.sent;
      s = e = val.length;
    }
    myExt = op.ext;
  }
  if (ops.length) {
    const before = ta.scrollHeight, top = ta.scrollTop;
    ta.value = val;
    ta.setSelectionRange(Math.min(s, val.length), Math.min(e, val.length));
    ta.scrollTop = Math.max(0, top - (before - ta.scrollHeight)); // 앞이 잘린 만큼 스크롤도 당김
  }
  lastValue = ta.value;
  emitText(); // 서버와 최종 글을 맞춰요 (버전도 최신으로)
}

function getBox(seatId, isMe) {
  let ta = boxes.get(seatId);
  if (ta) return ta;
  ta = document.createElement("textarea");
  ta.dataset.seat = seatId;
  ta.spellcheck = false;
  ta.value = texts[seatId] || "";
  // 송출된 부분 표시는 textarea 뒤에 겹친 배경 레이어(div)에 그려요
  const wrap = document.createElement("div");
  wrap.className = isMe ? "box-wrap" : "box-wrap ro";
  const hl = document.createElement("div");
  hl.className = "box-hl";
  hl.setAttribute("aria-hidden", "true");
  wrap.append(hl, ta);
  ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; });
  new ResizeObserver(() => paintBox(seatId)).observe(ta);
  if (isMe) {
    lastValue = ta.value;
    mySent = Math.min(sents[seatId] || 0, ta.value.length);
    if (exts[seatId] != null) myExt = exts[seatId];
    pendingOps = [];
    ta.placeholder = "여기에 입력하세요";
    ta.addEventListener("input", onMyInput);
    ta.addEventListener("keydown", onMyKeydown);
    ta.addEventListener("keyup", onMyKeyup);
    ta.addEventListener("compositionstart", () => { composing = true; });
    ta.addEventListener("compositionend", (e) => {
      composing = false;
      lastCommit = typeof e.data === "string" ? e.data : "";
      setTimeout(() => {
        if (composing) return;
        if (pendingOps.length) applyPendingOps();
        if (!checkReinsert(ta) && !ta.value.startsWith(lastValue.slice(0, mySent))) repairSent(ta);
        const jobs = afterIme;
        afterIme = [];
        for (const fn of jobs) fn();
      }, 0);
    });
  } else {
    ta.readOnly = true;
    ta.tabIndex = -1;
    ta.placeholder = "입력 내용이 실시간으로 표시돼요";
  }
  boxes.set(seatId, ta);
  return ta;
}

// ---------- 단축키 (내 입력칸에서만) ----------
const KEYS = {
  F1: "send", F3: "expand", F4: "delLast", F8: "delPartner",
  F10: "register", F12: "clearMine", Insert: "pass",
};
const NO_REPEAT = new Set(["pass", "clearMine", "register", "expand"]); // 꾹 누르고 있어도 한 번만

function onMyKeydown(e) {
  guardSentKeydown(e, e.currentTarget);
  guardBackspaceAtEdge(e, e.currentTarget);
  // 한글 조합 중엔 e.key가 "Process"일 수 있어서 물리 키(e.code)를 먼저 봐요
  const action = KEYS[e.code] || KEYS[e.key];
  if (!action) return;
  // Shift+Insert(붙여넣기), Ctrl+Insert(복사), Alt+F4 등 조합키는 그대로 둬요
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat && NO_REPEAT.has(action)) return;

  const ta = e.currentTarget;
  const imeBusy = composing || e.isComposing || e.keyCode === 229;
  // 윈도우 한글 IME: 조합 중에 키를 누르면 keydown이 두 번 와요 (조합 확정용 229 + 진짜 키).
  // 한 번 누른 걸 두 번 처리하면 F10이 등록 후 빈 줄을 다시 검사해 "형식" 오류를 띄우거나,
  // Insert가 턴을 두 번 넘기려 하므로 — 조합 중에 받은 키 직후 같은 키는 한 번 버려요.
  const now = Date.now();
  if (lastImeKey && lastImeKey.code === e.code && now - lastImeKey.t < 300) { lastImeKey = null; return; }
  lastImeKey = imeBusy ? { code: e.code, t: now } : null;
  if (!imeBusy && queuedKeys === 0) return runAction(action, ta);

  // 한글 조합 중에 누른 단축키: 지금 value는 "확정 전" 글이라 여기서 칸을 고치면
  // 조합 글자가 compositionend 때 다시 끼어들어요 (정:정상영 → 정상영영, 정 → 정정).
  // 그래서 조합이 확정된 뒤(compositionend 이후 setTimeout 0) value를 다시 읽어서 처리해요.
  // 앞서 미뤄둔 단축키가 있으면 순서를 지키려고 그 뒤에 줄을 세워요.
  queuedKeys++;
  keyQueue = keyQueue
    .then(() => afterComposition(ta))
    .then(() => {
      if (myBox() !== ta) return; // 그 사이 자리가 바뀌었으면 버림
      runAction(action, ta);
      armReinsertGuard(ta);
    })
    .catch((err) => console.error(err))
    .finally(() => { queuedKeys--; });
}

let keyQueue = Promise.resolve();
let queuedKeys = 0;        // 조합 확정을 기다리는 단축키 수
let lastCommit = "";       // 마지막 compositionend의 확정 글자
let lastImeKey = null;     // { code, t } — 조합 중에 받은 마지막 단축키 (중복 keydown 걸러내기)

// 조합이 끝나고 브라우저가 확정 글자를 칸에 넣은 뒤에 resolve.
// - 이미 조합이 끝났으면 setTimeout 0 한 번만 기다려요 (keyCode 229인데 compositionend가 먼저 온 경우).
// - 그 사이 새 조합이 시작되면 그 조합의 compositionend까지 기다려요.
// - compositionend가 끝내 오지 않으면(일부 IME) 포커스를 뺐다 돌려서 확정시키고, 그래도 안 되면 진행.
function afterComposition(ta) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      ta.removeEventListener("compositionend", settle);
      clearTimeout(forceTimer);
      clearTimeout(giveUpTimer);
    };
    function settle() {
      setTimeout(() => {
        if (done || composing) return;
        done = true;
        cleanup();
        resolve();
      }, 0);
    }
    ta.addEventListener("compositionend", settle);
    const forceTimer = setTimeout(() => {
      if (!done && composing) { ta.blur(); ta.focus(); }
    }, 400);
    const giveUpTimer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      composing = false;
      if (pendingOps.length) applyPendingOps();
      resolve();
    }, 1000);
    if (!composing) settle();
  });
}

// 안전장치: 미뤄서 처리한 직후, 방금 확정된 조합 글자가 커서 자리에 한 번 더 들어오면 되돌려요.
let reinsertGuard = null;
function armReinsertGuard(ta) {
  reinsertGuard = lastCommit
    ? { ta, value: ta.value, s: ta.selectionStart, e: ta.selectionEnd, data: lastCommit, until: Date.now() + 300 }
    : null;
}
function checkReinsert(ta) {
  const g = reinsertGuard;
  if (!g || g.ta !== ta || composing) return false;
  reinsertGuard = null;
  if (Date.now() > g.until || g.s !== g.e) return false;
  if (ta.value !== g.value.slice(0, g.s) + g.data + g.value.slice(g.s)) return false;
  const top = ta.scrollTop;
  ta.value = g.value;
  ta.setSelectionRange(g.s, g.e);
  ta.scrollTop = top;
  emitText();
  return true;
}

// 윈도우 크롬은 F10을 "손을 뗄 때" 메뉴 이동으로 처리할 수 있어서 keyup도 막아요
function onMyKeyup(e) {
  if ((e.code === "F10" || e.key === "F10") && !(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

const SERVER_ACTIONS = new Set(["send", "delPartner", "pass", "clearMine"]);

function runAction(action, ta) {
  if (!amWorker()) return;
  // 내 칸만 고치는 동작(F3/F4)은 끊겨 있어도 돼요 — 재연결 때 내 글이 서버로 다시 가요
  if (SERVER_ACTIONS.has(action) && !socket.connected) return toast("서버와 연결이 끊겨 있어요.");
  switch (action) {
    case "register":
      registerPhrase(ta);
      break;
    case "expand":
      expandPhrase(ta);
      break;
    case "send":
      if (!amMain()) return toast("작성중인 작업자만 송출할 수 있어요. (지금은 대기중)");
      emitText(); // 마지막 입력을 먼저 보내고 송출
      sendFirstWord(ta);
      break;
    case "delLast": {
      // 송출 안 된 부분의 마지막 어절만 지워요
      const v = ta.value;
      const nv = v.slice(0, mySent) + v.slice(mySent).replace(/\S+\s*$/, "");
      if (nv === v) return toast("지울 수 있는 어절이 없어요. (송출된 글은 지울 수 없어요)");
      const s = Math.min(ta.selectionStart, nv.length), en = Math.min(ta.selectionEnd, nv.length);
      ta.value = nv;
      ta.setSelectionRange(s, en);
      emitText();
      break;
    }
    case "delPartner":
      if (partnerSeat() === null) return toast("상대 작업자가 없어요.");
      socket.emit("delete_partner_word");
      break;
    case "clearMine":
      clearMyBox(ta);
      break;
    case "pass":
      passTurn();
      break;
  }
}

// ---------- 상용구 (서버에 작업자 이름별로 저장) ----------
// 서버가 "지금 내 자리의 이름"으로 찾은 목록만 보내줘요 → 다른 작업자·다른 탭 것과 섞이지 않아요.
let phrases = Object.create(null);   // { 입력어: 출력어 } — 프로토타입 없는 객체라 "__proto__"도 안전
let phraseOwner = null;              // 지금 목록의 주인 이름

socket.on("snippets", (d) => {
  if (!joined || !d) return;
  const obj = Object.create(null);
  if (d.items && typeof d.items === "object") {
    for (const [k, out] of Object.entries(d.items)) if (typeof out === "string") obj[k] = out;
  }
  phrases = obj;
  phraseOwner = d.name;
  renderPhraseList();
});
const hasPhrase = (k) => Object.prototype.hasOwnProperty.call(phrases, k);

// 내 칸의 내용을 바꾸고 커서를 놓은 뒤 모두에게 반영
function setMyText(ta, value, cursor) {
  const top = ta.scrollTop;
  ta.value = value;
  ta.setSelectionRange(cursor, cursor);
  ta.scrollTop = top;
  emitText();
}

// F10: 커서가 있는 줄의 "입력어:출력어"를 등록하고 그 줄을 지워요
function registerPhrase(ta) {
  const v = ta.value;
  const pos = ta.selectionStart;
  const start = v.lastIndexOf("\n", pos - 1) + 1;
  let end = v.indexOf("\n", pos);
  if (end === -1) end = v.length;
  const line = v.slice(start, end);
  if (start < mySent) {
    if (Date.now() - lastRegisterAt < 1000) return; // 키 중복 (위와 같은 이유)
    return toast("이미 송출된 줄은 상용구로 등록할 수 없어요.");
  }

  const m = line.match(/^\s*([^:：\s]+)\s*[:：](.*)$/); // 반각·전각 콜론 둘 다 허용
  const out = m ? m[2].trim() : "";   // 앞뒤 공백만 떼고 친 그대로
  if (!m || !out) {
    // 방금 등록하고 그 줄을 지운 직후 다시 불렸으면(키 중복) 조용히 무시 — 성공 뒤에 "형식 오류"가 뜨지 않게
    if (Date.now() - lastRegisterAt < 1000) return;
    return toast("상용구 형식: 한 줄에 입력어:출력어 (예: 굿:굿 굿즈) — 입력어는 띄어쓰기 없이");
  }
  if (!socket.connected) return toast("서버와 연결이 끊겨 있어 상용구를 저장할 수 없어요.");
  const key = m[1];

  // 줄과 그 줄바꿈 하나를 같이 지움 (마지막 줄이면 앞 줄바꿈을 지움)
  let cutStart = start, cutEnd = end;
  if (end < v.length) cutEnd = end + 1;
  else if (start > 0 && start - 1 >= mySent) cutStart = start - 1;
  setMyText(ta, v.slice(0, cutStart) + v.slice(cutEnd), cutStart);

  phrases[key] = out; // 바로 F3을 눌러도 되게 먼저 반영 (서버 응답으로 확정)
  renderPhraseList();
  lastRegisterAt = Date.now();
  const ok = () => toast(`등록되었습니다. (${key} → ${out})`);
  const fail = (msg) => {
    socket.emit("snippets_get"); // 서버 목록으로 되돌림
    toast(msg || "상용구를 서버에 저장하지 못했어요. 다시 시도해주세요.");
  };
  socket.timeout(8000).emit("snippet_set", { key, out }, (err, res) => {
    if (res && res.ok) return ok();
    if (res) return fail(res.message); // 서버가 분명히 거절한 경우만 실패
    // 응답이 늦거나 끊겼을 뿐 저장은 됐을 수 있어요 → 서버 목록에 실제로 들어갔는지 확인한 뒤 판단
    socket.timeout(5000).emit("snippets_get", (err2, list) => {
      const items = !err2 && list && list.items;
      if (items && Object.prototype.hasOwnProperty.call(items, key) && items[key] === out) return ok();
      fail();
    });
  });
}
let lastRegisterAt = 0;

// F3: 커서 바로 앞 어절이 입력어면 출력어로 바꿔요
function expandPhrase(ta) {
  const v = ta.value;
  const pos = ta.selectionEnd;
  const m = v.slice(0, pos).match(/\S+$/);
  if (!m) return toast("커서 바로 앞에 어절이 없어요.");
  const key = m[0];
  if (pos - key.length < mySent) return toast("이미 송출된 어절은 바꿀 수 없어요.");
  if (!hasPhrase(key)) return toast(`'${key}'은(는) 등록된 상용구가 아니에요.`);
  const out = phrases[key];
  const start = pos - key.length;
  setMyText(ta, v.slice(0, start) + out + v.slice(pos), start + out.length);
}

function renderPhraseList() {
  const keys = Object.keys(phrases).sort((a, b) => a.localeCompare(b, "ko"));
  $("phrase-count").textContent = phraseOwner ? `${phraseOwner} · ${keys.length}개` : `${keys.length}개`;
  $("phrase-list").innerHTML = keys.length
    ? keys.map((k) => `<li>
        <span class="p-key" title="${esc(k)}">${esc(k)}</span><span class="p-arrow">→</span>
        <span class="p-out">${esc(phrases[k])}</span>
        <button class="icon-btn" data-del-phrase="${esc(k)}" title="삭제">🗑️</button></li>`).join("")
    : `<li class="empty">${joined ? "등록된 상용구가 없어요" : "입장하면 내 이름의 상용구가 보여요"}</li>`;
}

let phraseReturnFocus = null;
function openPhrases() {
  phraseReturnFocus = document.activeElement;
  renderPhraseList();
  $("phrase-modal").classList.remove("hidden");
  $("phrase-close").focus();
}
function closePhrases() {
  $("phrase-modal").classList.add("hidden");
  if (phraseReturnFocus && document.contains(phraseReturnFocus)) phraseReturnFocus.focus();
  phraseReturnFocus = null;
}
$("phrase-btn").addEventListener("click", openPhrases);
$("phrase-close").addEventListener("click", closePhrases);
$("phrase-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) return closePhrases(); // 바깥 클릭
  const del = e.target.closest("[data-del-phrase]");
  if (del) {
    const k = del.dataset.delPhrase;
    if (!socket.connected) return toast("서버와 연결이 끊겨 있어 삭제할 수 없어요.");
    socket.timeout(5000).emit("snippet_del", { key: k }, (err, res) => {
      if (err || !res || !res.ok) return toast((res && res.message) || "상용구를 삭제하지 못했어요.");
      if (hasPhrase(k)) { delete phrases[k]; renderPhraseList(); }
      toast(`상용구 삭제: ${k}`);
    });
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("phrase-modal").classList.contains("hidden")) closePhrases();
});

// ---------- 방송 영상 (YouTube IFrame Player API, 방 전체가 같이 봐요) ----------
// 서버가 { id, playing, pos(기준 시간), at(기준 시각) }을 들고 있고, 각자 플레이어를 그 상태에 맞춰요.
// 지금 위치 = playing ? pos + (서버 지금 - at) : pos.  1.5초 넘게 어긋나면 자동으로 맞춰요.
// 열기·조작은 작업자만, 관전자는 보기만 (플레이어 위에 투명 막을 씌워요).
let ytPlayer = null;       // YT.Player
let ytReady = false;       // 플레이어 준비 완료
let ytApiPromise = null;
let vs = null;             // 서버의 영상 상태
let clockOffset = 0;       // 서버 시계 - 내 시계 (초)
let suppressUntil = 0;     // 코드로 플레이어를 움직인 직후엔 상태 변화를 "사용자 조작"으로 보지 않음
let lastPlayerTouch = 0;   // 플레이어(iframe)를 마지막으로 클릭한 시각
let mutedByUs = false;     // 자동재생 제한 때문에 우리가 소리를 끈 상태
let playBlocked = false;   // 소리를 꺼도 재생이 막힘 → 클릭해야 재생
let autoplayTimer = null;
const DRIFT_MAX = 1.5;     // 재생 중 이만큼(초) 넘게 어긋나면 맞춤

const serverNow = () => Date.now() / 1000 + clockOffset;

// 서버 시계와의 차이: 왕복 시간의 절반을 빼서 계산 (입장 때, 그리고 1분마다)
function syncClock() {
  const t0 = Date.now();
  socket.timeout(5000).emit("clock", (err, res) => {
    if (err || !res) return;
    const t1 = Date.now();
    clockOffset = res.now - (t0 + t1) / 2000;
  });
}
socket.on("connect", syncClock);
setInterval(() => { if (socket.connected) syncClock(); }, 60000);

// 링크 → { id, start }. watch?v= / youtu.be/ / /live/ / /shorts/ / /embed/ / 11자리 id
function parseYouTube(raw) {
  let s = (raw || "").trim();
  if (!s) return null;
  if (/^[\w-]{11}$/.test(s)) return { id: s, start: 0 };
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  let id = null;
  if (host === "youtu.be") {
    id = u.pathname.split("/")[1];
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:live|shorts|embed|v)\/([\w-]{11})/);
      if (m) id = m[1];
    }
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  return { id, start: parseStart(u.searchParams.get("t") || u.searchParams.get("start")) };
}
// t=90, t=90s, t=1m30s, t=1h2m3s
function parseStart(t) {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
}

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.onerror = () => { ytApiPromise = null; s.remove(); reject(new Error("load")); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

const YT_ERRORS = {
  2: "링크의 영상 ID가 잘못됐어요.",
  5: "이 영상은 브라우저에서 재생할 수 없어요.",
  100: "영상을 찾을 수 없어요. (삭제됐거나 비공개)",
  101: "이 영상은 퍼가기(외부 재생)가 막혀 있어요. 유튜브에서 직접 봐주세요.",
  150: "이 영상은 퍼가기(외부 재생)가 막혀 있어요. 유튜브에서 직접 봐주세요.",
};

// ----- 서버 상태 받기 -----
socket.on("video", (d) => {
  if (!joined) return;
  if (d.by && vs && d.video && d.video.id !== vs.id && myInfo() && d.by !== myInfo().name) toast(`${d.by}님이 새 영상을 열었어요.`);
  applyVideo(d);
});

function applyVideo(d) {
  const prevId = vs && vs.id;
  vs = d && d.video ? d.video : null;
  if (vs && vs.id !== prevId) { playBlocked = false; }
  updateVideoUI();
  if (!vs) return;
  const url = $("yt-url");
  if (document.activeElement !== url) url.value = `https://youtu.be/${vs.id}`;
  ensurePlayer().then(() => syncPlayer(true)).catch(() => {});
}

// 지금 영상이 있어야 할 위치(초)
function expectedPos() {
  if (!vs) return 0;
  let t = vs.playing ? vs.pos + Math.max(0, serverNow() - vs.at) : vs.pos;
  const dur = ytReady && ytPlayer.getDuration ? ytPlayer.getDuration() || 0 : 0;
  if (dur > 0 && !isLive()) t = Math.min(t, Math.max(0, dur - 0.3));
  return t;
}
function isLive() {
  try { return !!(ytPlayer.getVideoData && ytPlayer.getVideoData().isLive); } catch { return false; }
}
const suppress = (ms = 1500) => { suppressUntil = Date.now() + ms; };
const playerTime = () => (ytReady && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() || 0 : expectedPos());

async function ensurePlayer() {
  if (ytPlayer) return;
  try {
    await loadYouTubeApi();
  } catch (e) {
    toast("유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인해주세요.");
    throw e;
  }
  if (ytPlayer || !vs) return;
  ytPlayer = new YT.Player("yt-player", {
    playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: () => { ytReady = true; syncPlayer(true); },
      onStateChange: onPlayerState,
      onError: (e) => toast(YT_ERRORS[e.data] || `영상을 재생할 수 없어요. (오류 ${e.data})`),
    },
  });
}

// 플레이어를 서버 상태에 맞춰요. hard=true면 조금만 어긋나도 맞춤 (상태가 막 바뀌었을 때)
function syncPlayer(hard = false) {
  if (!ytReady || !vs) return;
  const exp = expectedPos();
  let curId = null;
  try { curId = ytPlayer.getVideoData().video_id; } catch {}
  if (curId !== vs.id) {
    suppress(2500);
    if (vs.playing) {
      ytPlayer.loadVideoById({ videoId: vs.id, startSeconds: exp });
      scheduleAutoplayCheck();
    } else {
      ytPlayer.cueVideoById({ videoId: vs.id, startSeconds: exp });
    }
    return;
  }
  const st = ytPlayer.getPlayerState();
  const cur = ytPlayer.getCurrentTime() || 0;
  if (vs.playing) {
    if (st === 0 && !isLive() && exp >= (ytPlayer.getDuration() || 0) - 1) return; // 끝까지 재생됨
    if (Math.abs(cur - exp) > (hard ? 1.0 : DRIFT_MAX)) { suppress(); ytPlayer.seekTo(exp, true); }
    if (st !== 1 && st !== 3 && !playBlocked) {
      suppress();
      ytPlayer.playVideo();
      scheduleAutoplayCheck();
    }
  } else {
    if (st === 1 || st === 3) { suppress(); ytPlayer.pauseVideo(); }
    // 맨 처음 불러온(cue) 상태에서 seekTo를 하면 재생이 시작돼서 건너뜀 (cue에 시작 위치가 들어 있어요)
    if (st !== 5 && st !== -1 && Math.abs(cur - exp) > 0.5) { suppress(); ytPlayer.seekTo(exp, true); }
  }
}

// 2초마다 어긋남 확인. 작업자가 방금 플레이어를 직접 만졌다면(시간 이동) 그걸 모두에게 보내요.
setInterval(() => {
  if (!joined || !ytReady || !vs) return;
  if (userTouchingPlayer()) {
    const cur = playerTime(), exp = expectedPos();
    if (Math.abs(cur - exp) > (vs.playing ? DRIFT_MAX : 0.5)) return sendVideo("seek", cur, false);
  }
  syncPlayer(false);
}, 2000);

// 작업자가 플레이어를 클릭한 직후(5초)에 생긴 변화만 "사용자 조작"으로 봐요.
// (버퍼링으로 잠깐 멈춘 걸 일시정지로 착각해서 모두를 멈추게 하지 않으려고)
function userTouchingPlayer() {
  if (!amWorker() || Date.now() < suppressUntil) return false;
  const iframe = ytPlayer && ytPlayer.getIframe ? ytPlayer.getIframe() : null;
  return Date.now() - lastPlayerTouch < 5000 || (iframe && document.activeElement === iframe);
}

function onPlayerState(e) {
  if (!vs) return;
  if (e.data === 1 && mutedByUs) showUnlock("sound");
  if (e.data === 1 || e.data === 3) { if (playBlocked) { playBlocked = false; hideUnlock(); } }
  if (!userTouchingPlayer()) return;
  const cur = playerTime();
  if (e.data === 1 && !vs.playing) sendVideo("play", cur, false);
  else if (e.data === 2 && vs.playing) sendVideo("pause", cur, false);
  else if ((e.data === 1 || e.data === 2) && Math.abs(cur - expectedPos()) > (vs.playing ? DRIFT_MAX : 0.5)) sendVideo("seek", cur, false);
}

// 작업자의 조작 → 내 상태를 먼저 바꾸고(바로 반응) 서버로 보내요
function sendVideo(action, pos, applyLocal = true) {
  if (!vs) return;
  if (!amWorker()) return toast("영상 조작은 작업자만 할 수 있어요.");
  if (!socket.connected) return toast("서버와 연결이 끊겨 있어요.");
  vs = { ...vs, pos: Math.max(0, pos), at: serverNow(), playing: action === "play" ? true : action === "pause" ? false : vs.playing };
  if (applyLocal) syncPlayer(true);
  else suppress(800);
  socket.emit("video_ctrl", { action, pos: vs.pos });
}

// ----- 자동재생 제한 -----
// 소리 있는 재생이 막히면 → 소리를 끄고 재생 + "클릭해서 소리 켜기", 그래도 막히면 "클릭해서 재생"
let autoplayPending = false; // 확인이 진행 중이면 2초마다 도는 맞추기가 다시 시작하지 않게
function scheduleAutoplayCheck() {
  if (autoplayPending) return;
  autoplayPending = true;
  const done = () => { autoplayPending = false; };
  autoplayTimer = setTimeout(() => {
    if (!vs || !vs.playing || !ytReady) return done();
    const st = ytPlayer.getPlayerState();
    if (st === 1 || st === 3) return done();
    mutedByUs = true;
    ytPlayer.mute();
    suppress();
    ytPlayer.playVideo();
    autoplayTimer = setTimeout(() => {
      done();
      if (!vs || !vs.playing || !ytReady) return;
      const st2 = ytPlayer.getPlayerState();
      if (st2 === 1 || st2 === 3) showUnlock("sound");
      else { playBlocked = true; showUnlock("play"); }
    }, 1500);
  }, 1500);
}
function showUnlock(kind) {
  const b = $("yt-unlock");
  b.dataset.kind = kind;
  b.textContent = kind === "play" ? "▶ 클릭해서 재생" : "🔇 클릭해서 소리 켜기";
  b.classList.remove("hidden");
}
function hideUnlock() { $("yt-unlock").classList.add("hidden"); }
$("yt-unlock").addEventListener("click", () => {
  if (!ytReady) return;
  ytPlayer.unMute();
  mutedByUs = false;
  playBlocked = false;
  hideUnlock();
  syncPlayer(true);
  if (vs && vs.playing) { suppress(); ytPlayer.playVideo(); }
  const box = myBox();
  if (box) box.focus(); // 입력하던 칸으로 돌아가요
});

// ----- 화면 -----
function updateVideoUI() {
  const worker = amWorker();
  $("yt-form").classList.toggle("hidden", !worker);
  $("yt-shield").classList.toggle("hidden", worker);
  $("yt-empty").classList.toggle("hidden", !!vs);
  $("yt-wrap").classList.toggle("hidden", !vs);
  $("yt-empty").innerHTML = worker
    ? '유튜브 링크를 넣고 "열기"를 누르세요.<br>방에 있는 모두에게 같은 영상이 재생돼요.'
    : "작업자가 영상을 열면 여기에 같이 재생돼요.";
}

function teardownVideo() {
  clearTimeout(autoplayTimer);
  autoplayPending = false;
  vs = null;
  if (ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
  }
  ytPlayer = null;
  ytReady = false;
  mutedByUs = playBlocked = false;
  hideUnlock();
  if (!$("yt-player")) {
    const div = document.createElement("div");
    div.id = "yt-player";
    $("yt-wrap").prepend(div);
  }
  updateVideoUI();
}

$("yt-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!amWorker()) return toast("영상은 작업자만 열 수 있어요.");
  const v = parseYouTube($("yt-url").value);
  if (!v) return toast("유튜브 링크 형식이 아니에요. (watch?v= · youtu.be · /live/ · /shorts/)");
  if (!socket.connected) return toast("서버와 연결이 끊겨 있어요.");
  socket.emit("video_open", { id: v.id, start: v.start });
});

let flashTimer = null;
function flash(text) {
  const f = $("yt-flash");
  f.textContent = text;
  f.classList.remove("hidden");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.add("hidden"), 600);
}
function seekBy(delta) {
  if (!vs) return;
  if (!amWorker()) return toast("영상 조작은 작업자만 할 수 있어요.");
  sendVideo("seek", playerTime() + delta);
  flash(delta < 0 ? `◀◀ ${-delta}초` : `${delta}초 ▶▶`);
}
function togglePlay() {
  if (!vs) return toast("열린 영상이 없어요.");
  if (!amWorker()) return toast("영상 조작은 작업자만 할 수 있어요.");
  const play = !vs.playing;
  sendVideo(play ? "play" : "pause", playerTime());
  flash(play ? "▶ 재생" : "❚❚ 일시정지");
}

// F2 재생/일시정지, F7/F9 2초 뒤로/앞으로: 어디에 포커스가 있든(입력칸 포함) 동작, 포커스는 그대로.
// 캡처 단계에서 먼저 받아서 처리 — 크롬의 F7(캐럿 브라우징 안내창)도 막아요.
const VIDEO_KEYS = { F2: "toggle", F7: -2, F9: 2 };
document.addEventListener("keydown", (e) => {
  const k = VIDEO_KEYS[e.code] ?? VIDEO_KEYS[e.key];
  if (k === undefined || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  if (!joined || e.repeat && k === "toggle") return;
  if (k === "toggle") togglePlay(); else seekBy(k);
}, true);

// 영상(iframe)을 클릭하면 키보드 포커스가 유튜브로 넘어가서 타이핑·단축키가 먹히지 않아요.
// 직전에 내 입력칸에 있었다면 바로 되돌려줘요 (커서 위치는 textarea가 기억).
let lastFocused = null;
document.addEventListener("focusin", (e) => { lastFocused = e.target; });
window.addEventListener("blur", () => {
  setTimeout(() => {
    const active = document.activeElement;
    if (!(active && active.tagName === "IFRAME" && $("yt-wrap").contains(active))) return;
    lastPlayerTouch = Date.now(); // 플레이어를 직접 조작하는 중
    const box = myBox();
    if (box && lastFocused === box) box.focus();
  }, 0);
});

// ---------- 세 칸 폭 조절 (영상 / 입력칸 / 송출 이력) — 각자 브라우저에 저장 ----------
// 폭은 비율(합 100)로 들고 있다가 CSS 변수 --col-a/b/c 로 넣어요. 경계선을 끌면 양옆 두 칸만 바뀌어요.
// "영상 크게": 지금 비율을 기억해 두고 영상 칸을 넓힌 비율로 → 다시 누르면 기억한 비율로 되돌려요.
const LAYOUT_KEY = "live_layout";
const COLS_DEFAULT = [45, 32, 23];
const COLS_VIDEO_BIG = [62, 23, 15];
const COL_MIN_PX = 200;    // 칸 최소 폭
let layout = loadLayout(); // { cols: [a,b,c], big: bool, prev: [a,b,c] | null }

function validCols(c) {
  return Array.isArray(c) && c.length === 3 && c.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
}
function normCols(c) {
  const sum = c[0] + c[1] + c[2];
  return c.map((n) => (n / sum) * 100);
}
function loadLayout() {
  const out = { cols: COLS_DEFAULT.slice(), big: false, prev: null };
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY));
    if (v && validCols(v.cols)) out.cols = normCols(v.cols);
    if (v && v.big && validCols(v.prev)) { out.big = true; out.prev = normCols(v.prev); }
  } catch {}
  return out;
}
function saveLayout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch {}
}
function applyLayout() {
  const g = document.querySelector(".work-grid");
  ["a", "b", "c"].forEach((k, i) => g.style.setProperty(`--col-${k}`, `${layout.cols[i].toFixed(3)}fr`));
  const b = $("video-big");
  b.textContent = layout.big ? "원래대로" : "영상 크게";
  b.classList.toggle("on", layout.big);
  b.setAttribute("aria-pressed", String(layout.big));
}
applyLayout();

$("video-big").addEventListener("click", () => {
  if (layout.big) {
    layout = { cols: layout.prev || COLS_DEFAULT.slice(), big: false, prev: null };
  } else {
    layout = { cols: COLS_VIDEO_BIG.slice(), big: true, prev: layout.cols.slice() };
  }
  applyLayout();
  saveLayout();
  const box = myBox();
  if (box && lastFocused === box) box.focus(); // 치던 칸으로 돌아가요
});

// 경계선 끌기 (Pointer Events + 포인터 캡처: 영상 iframe 위로 지나가도 안 끊겨요)
document.querySelectorAll(".col-resizer").forEach((bar) => {
  const i = Number(bar.dataset.resizer); // 0: 영상|입력칸, 1: 입력칸|송출 이력
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grid = bar.parentElement;
    const panels = [...grid.children].filter((el) => el.classList.contains("panel"));
    const widths = panels.map((p) => p.getBoundingClientRect().width);
    const total = widths[0] + widths[1] + widths[2];
    const pairStart = panels[i].getBoundingClientRect().left;
    const pair = widths[i] + widths[i + 1];
    const gutter = bar.getBoundingClientRect().width;
    const min = Math.min(COL_MIN_PX, pair / 2 - 1);
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    document.body.classList.add("col-resizing");

    const move = (ev) => {
      const left = Math.max(min, Math.min(pair - min, ev.clientX - pairStart - gutter / 2));
      const px = widths.slice();
      px[i] = left;
      px[i + 1] = pair - left;
      layout.cols = px.map((w) => (w / total) * 100);
      applyLayout();
    };
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      bar.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
      saveLayout();
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });
  // 더블클릭: 기본 크기로
  bar.addEventListener("dblclick", () => {
    layout = { cols: COLS_DEFAULT.slice(), big: false, prev: null };
    applyLayout();
    saveLayout();
  });
});

// ---------- 송출 이력 ----------
// 송출 이력은 옆 패널과 "크게 보기" 화면 두 곳에 똑같이 그려요. 최신 줄이 항상 보이게 맨 아래로.
const historyEls = () => [$("history"), $("big-text")];
function scrollHistory() {
  for (const el of historyEls()) el.scrollTop = el.scrollHeight;
}
function setHistory(text) {
  historyText = text;
  for (const el of historyEls()) el.textContent = text;
  scrollHistory();
}
function appendHistory(chunk) {
  historyText += chunk;
  for (const el of historyEls()) el.appendChild(document.createTextNode(chunk));
  scrollHistory();
}

// ----- 글자 크기 (각자 브라우저에 저장) -----
const FONT_KEY = "live_hist_font";
const FONT_LIMITS = { panel: [14, 48, 22], big: [24, 120, 56] }; // [최소, 최대, 기본]
let fontSizes = loadFontSizes();
function loadFontSizes() {
  const out = { panel: FONT_LIMITS.panel[2], big: FONT_LIMITS.big[2] };
  try {
    const v = JSON.parse(localStorage.getItem(FONT_KEY));
    for (const k of Object.keys(out)) {
      const n = v && typeof v === "object" ? v[k] : undefined;
      if (typeof n === "number" && Number.isFinite(n)) out[k] = Math.min(FONT_LIMITS[k][1], Math.max(FONT_LIMITS[k][0], n));
    }
  } catch {}
  return out;
}
function applyFontSizes() {
  document.documentElement.style.setProperty("--hist-font", fontSizes.panel + "px");
  document.documentElement.style.setProperty("--big-font", fontSizes.big + "px");
  scrollHistory();
}
function changeFont(which, dir) {
  const [lo, hi] = FONT_LIMITS[which];
  const step = which === "big" ? 8 : 2;
  fontSizes[which] = Math.min(hi, Math.max(lo, fontSizes[which] + dir * step));
  try { localStorage.setItem(FONT_KEY, JSON.stringify(fontSizes)); } catch {}
  applyFontSizes();
  toast(`글자 크기 ${fontSizes[which]}px`);
}
applyFontSizes();
$("font-down").addEventListener("click", () => changeFont("panel", -1));
$("font-up").addEventListener("click", () => changeFont("panel", 1));
$("big-font-down").addEventListener("click", () => changeFont("big", -1));
$("big-font-up").addEventListener("click", () => changeFont("big", 1));

// ----- 크게 보기 (송출 이력만 화면 전체에, 검은 배경·흰 글씨) -----
let bigReturnFocus = null;
const bigOpen = () => !$("big-view").classList.contains("hidden");
function openBig() {
  bigReturnFocus = lastFocused === myBox() ? myBox() : null;
  $("big-view").classList.remove("hidden");
  scrollHistory();
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {}); // 진짜 전체 화면 (안 되면 창 안에서만)
  if (bigReturnFocus) bigReturnFocus.focus(); // 작업자는 크게 보면서도 계속 칠 수 있게
}
function closeBig() {
  if (!bigOpen()) return;
  $("big-view").classList.add("hidden");
  if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  scrollHistory();
  if (bigReturnFocus && document.contains(bigReturnFocus)) bigReturnFocus.focus();
  bigReturnFocus = null;
}
$("big-btn").addEventListener("click", openBig);
$("big-close").addEventListener("click", closeBig);
// 전체 화면에서 ESC를 누르면 브라우저가 전체 화면을 먼저 끄므로 그때 같이 닫아요
document.addEventListener("fullscreenchange", () => { if (!document.fullscreenElement) closeBig(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && bigOpen()) closeBig();
});

$("history-download").addEventListener("click", () => {
  if (!historyText) return toast("송출 이력이 비어 있어요.");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const name = `송출이력_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.txt`;
  const blob = new Blob(["﻿" + historyText.replace(/\r?\n/g, "\r\n")], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// 초기화: 한 번 누르면 빨갛게 바뀌고, 3초 안에 한 번 더 누르면 실행
let clearArmed = null;
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  const b = $("history-clear");
  b.classList.remove("danger");
  b.textContent = "초기화";
}
$("history-clear").addEventListener("click", () => {
  if (!amWorker()) return toast("작업자만 송출 이력을 초기화할 수 있어요.");
  if (clearArmed) {
    disarmClear();
    socket.emit("clear_history");
    return;
  }
  const b = $("history-clear");
  b.classList.add("danger");
  b.textContent = "한 번 더 누르면 초기화";
  clearArmed = setTimeout(disarmClear, 3000);
});

// ---------- 화면 그리기 ----------
function render() {
  if (currentRoom === null) {
    // 첫 화면: 방 목록
    $("rooms").classList.remove("hidden");
    $("lobby").classList.add("hidden");
    $("room").classList.add("hidden");
    document.title = "실시간 방송 자막";
    return renderRooms();
  }
  $("rooms").classList.add("hidden");
  if (!state) return;
  const inRoom = joined && me && state.seats[me.seat] && state.seats[me.seat].taken;
  $("lobby").classList.toggle("hidden", inRoom);
  $("room").classList.toggle("hidden", !inRoom);
  document.title = `${state.room_name} · 실시간 방송 자막`;
  $("lobby-title").textContent = state.room_name;
  $("room-name").textContent = state.room_name;
  if (inRoom) renderRoom(); else renderLobby();
}

// ---------- 방 목록 / 방 이동 ----------
function renderRooms() {
  const grid = $("room-grid");
  const activeEl = document.activeElement;
  if (editingRoom !== null && activeEl && activeEl.classList.contains("room-name-input")) return; // 입력 중이면 다시 그리지 않음
  grid.innerHTML = roomsList.map((r) => {
    const nameHtml = editingRoom === r.id
      ? `<input class="seat-name-input room-name-input" data-room-input="${r.id}" maxlength="20" value="${esc(r.name)}">`
      : `<span class="room-title" title="${esc(r.name)}">${esc(r.name)}</span>`;
    return `
      <div class="room-card" data-room="${r.id}" role="button" tabindex="0" aria-label="${esc(r.name)} 들어가기">
        <div class="room-top">
          ${nameHtml}
          <button class="icon-btn" data-rename-room="${r.id}" title="방 이름 바꾸기">✏️</button>
        </div>
        <div class="room-counts">
          <span class="room-count workers">작업자 ${r.workers}/${r.max_workers}</span>
          <span class="room-count">관전자 ${r.spectators}</span>
        </div>
        <span class="room-num">방 ${r.id} · <span class="room-enter">들어가기 →</span></span>
      </div>`;
  }).join("") || '<p class="sub">방 목록을 불러오는 중…</p>';

  const input = grid.querySelector(".room-name-input");
  if (input) {
    input.focus();
    input.select();
    const finish = (save) => {
      if (editingRoom === null) return;
      const room = Number(input.dataset.roomInput);
      editingRoom = null;
      if (save && input.value.trim()) socket.emit("rename_room", { room, name: input.value });
      renderRooms();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("blur", () => finish(true), { once: true });
  }
}

$("room-grid").addEventListener("click", (e) => {
  const ren = e.target.closest("[data-rename-room]");
  if (ren) {
    e.stopPropagation();
    editingRoom = Number(ren.dataset.renameRoom);
    return renderRooms();
  }
  if (e.target.closest(".room-name-input")) return;
  const card = e.target.closest("[data-room]");
  if (card) goRoom(Number(card.dataset.room));
});
$("room-grid").addEventListener("keydown", (e) => {
  const card = e.target.closest("[data-room]");
  if (card && e.target === card && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    goRoom(Number(card.dataset.room));
  }
});

// 방으로 이동 (방 목록 → 방 입장 화면). 주소도 /room/N 으로
function goRoom(n, push = true) {
  if (joined) return;
  if (push) history.pushState({ room: n }, "", `/room/${n}`);
  currentRoom = n;
  state = null;
  editingSeat = null;
  resetRoomLocal();
  setHistory("");
  enterRoute();
  render();
}
// 방 목록으로 (자리에 앉아 있지 않을 때만 — 앉아 있으면 "나가기" 먼저)
function goRooms(push = true) {
  if (joined) return toast("먼저 '나가기'를 눌러 자리에서 나와주세요.");
  if (push) history.pushState({}, "", "/");
  socket.emit("unwatch");
  currentRoom = null;
  state = null;
  editingRoom = null;
  resetRoomLocal();
  setHistory("");
  render();
}
$("to-rooms").addEventListener("click", () => goRooms());

// 브라우저 뒤로/앞으로
window.addEventListener("popstate", () => {
  const target = roomFromPath();
  if (target === currentRoom) return;
  if (joined) {
    // 자리에 앉아 있으면 주소만 되돌리고 그대로 (실수로 자리를 잃지 않게)
    history.pushState({ room: currentRoom }, "", `/room/${currentRoom}`);
    return toast("먼저 '나가기'를 눌러 자리에서 나와주세요.");
  }
  if (target === null) goRooms(false); else goRoom(target, false);
});

function seatStatus(s) {
  if (!s.taken) return { dot: "", text: "비어 있음" };
  if (!s.online) return { dot: "offline", text: "연결 끊김 (잠시 대기)" };
  return { dot: s.role, text: s.role === "worker" ? "작업 중" : "관전 중" };
}

function renderLobby() {
  const grid = $("seat-grid");
  const activeEl = document.activeElement;
  if (editingSeat !== null && activeEl && activeEl.classList.contains("seat-name-input")) return; // 입력 중이면 다시 그리지 않음

  grid.innerHTML = state.seats.map((s) => {
    const st = seatStatus(s);
    const nameHtml = editingSeat === s.id
      ? `<input class="seat-name-input" data-seat="${s.id}" maxlength="12" value="${esc(s.name)}">`
      : `<span class="seat-name">${esc(s.name)}</span>`;
    return `
      <div class="seat ${s.taken ? "taken" : ""}">
        <div class="seat-top">
          <span class="seat-num">${s.id + 1}</span>
          ${nameHtml}
          <button class="icon-btn" data-rename="${s.id}" title="이름 수정" ${s.taken ? "disabled" : ""}>✏️</button>
        </div>
        <div class="seat-status"><span class="dot ${st.dot}"></span>${st.text}</div>
        <button class="btn" data-join="${s.id}" ${s.taken ? "disabled" : ""}>${s.taken ? "사용 중" : "입장"}</button>
      </div>`;
  }).join("");

  $("lobby-full").classList.toggle("hidden", state.seats.some((s) => !s.taken));

  const input = grid.querySelector(".seat-name-input");
  if (input) {
    input.focus();
    input.select();
    const finish = (save) => {
      const seat = Number(input.dataset.seat);
      editingSeat = null;
      if (save && input.value.trim()) socket.emit("rename", { seat, name: input.value });
      render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }
}

$("seat-grid").addEventListener("click", (e) => {
  const join = e.target.closest("[data-join]");
  const rename = e.target.closest("[data-rename]");
  if (join && !join.disabled) {
    saveMe(null);
    resetRoomLocal();
    socket.emit("join", { room: currentRoom, seat: Number(join.dataset.join) });
  } else if (rename && !rename.disabled) {
    editingSeat = Number(rename.dataset.rename);
    renderLobby();
  }
});

function renderRoom() {
  const mine = state.seats[me.seat];
  $("me-name").textContent = mine.name;
  $("me-role").textContent = roleText(mine.role);
  $("me-role").className = `badge ${mine.role}`;

  // 내 칸이 다른 자리로 옮겨질 때(앞 작업자가 나감) 포커스·커서를 되살리려고 기억
  const myTa = myBox();
  const hadFocus = myTa && document.activeElement === myTa;
  const sel = hadFocus ? [myTa.selectionStart, myTa.selectionEnd, myTa.scrollTop] : null;

  // 작업자 2칸
  const workers = state.seats.filter((s) => s.taken && s.role === "worker").sort((a, b) => a.order - b.order);
  for (let i = 0; i < state.max_workers; i++) {
    const el = $(`writer-${i}`);
    const w = workers[i];
    if (!w) {
      delete el.dataset.seat;
      el.className = "writer empty";
      el.innerHTML = `<div class="writer-head"><span class="tag">작업자 자리 ${i + 1}</span></div>
        <div class="writer-body">빈 자리</div>`;
      continue;
    }
    const isMe = w.id === me.seat;
    const isMain = state.main_seat === w.id;
    el.className = `writer${isMain ? " main" : ""}`;
    // textarea는 자리마다 하나를 계속 재사용 (다시 만들면 커서·조합이 날아가요)
    if (el.dataset.seat !== String(w.id) || !el.contains(boxes.get(w.id))) {
      el.dataset.seat = w.id;
      el.innerHTML = `<div class="writer-head"></div>`;
      el.appendChild(getBox(w.id, isMe).parentElement); // textarea + 송출 표시 레이어
    }
    // 대기 작업자가 Enter를 쳤으면 칸 전체가 노란 창 (턴을 받으면 서버가 꺼요)
    boxes.get(w.id).parentElement.classList.toggle("standby", !!w.standby && !isMain);
    // 이름 앞 배지: 작성중 = 초록, 대기중 = 주황 (모든 사람 화면에서 같은 state로 그려요)
    el.querySelector(".writer-head").innerHTML =
      `<span class="turn-badge ${isMain ? "writing" : "waiting"}">${isMain ? "작성중" : "대기중"}</span>
       <span class="who">${esc(w.name)}</span>${isMe ? '<span class="tag">(나)</span>' : ""}
       ${w.online ? "" : '<span class="dot offline"></span><span class="tag">연결 끊김</span>'}
       ${isMe && isMain ? '<button class="btn small pass-btn" data-pass title="단축키: Insert">턴 넘기기</button>' : ""}`;
  }
  // 더 이상 작업자가 아닌 자리의 칸은 버림
  for (const seat of [...boxes.keys()]) {
    if (!workers.some((w) => w.id === seat)) boxes.delete(seat);
  }
  if (hadFocus && myBox() === myTa && document.activeElement !== myTa) {
    myTa.focus();
    myTa.setSelectionRange(sel[0], sel[1]);
    myTa.scrollTop = sel[2];
  }

  const worker = amWorker();
  updateVideoUI();
  $("history-clear").classList.toggle("hidden", !worker);

  // 작업자 → 관전자로 바뀌었으면 내 칸 관련 상태 정리
  if (!worker) { pendingOps = []; afterIme = []; composing = false; }
  if (!amMain()) passingUntil = 0; // 턴이 넘어간 게 확인됨
  if (amMain()) maybeAutoSend(); // 턴을 받았을 때 이미 완성 어절이 3개 이상이면 바로 송출
  if (swapArm && !(worker && state.seats[swapArm.target] && state.seats[swapArm.target].ready)) disarmSwap();

  // 대기열 (관전자, 들어온 순서대로). 초록불 = 작업하고 싶다는 신호
  const waiting = state.seats.filter((s) => s.taken && s.role === "spectator").sort((a, b) => a.order - b.order);
  $("queue-list").innerHTML = waiting.length
    ? waiting.map((s) => {
        const isMe = s.id === me.seat;
        // 누를 수 있는 칩: 관전자는 자기 칩, 작업자는 초록불 켜진 칩
        const clickable = worker ? s.ready : (isMe && mine.role === "spectator");
        const title = worker
          ? (s.ready ? "눌러서 이 관전자와 자리 바꾸기" : "초록불이 꺼져 있어요")
          : (isMe ? (s.ready ? "눌러서 초록불 끄기" : "눌러서 초록불 켜기 (작업하고 싶어요)") : "");
        const armed = swapArm && swapArm.target === s.id;
        return `<button type="button" class="chip ${isMe ? "me" : ""} ${s.ready ? "ready" : ""} ${clickable ? "clickable" : ""} ${armed ? "armed" : ""}"
            data-chip="${s.id}" ${clickable ? "" : 'aria-disabled="true"'} title="${title}">
          <span class="dot ${!s.online ? "offline" : s.ready ? "ready" : "spectator"}"></span>${esc(s.name)}</button>`;
      }).join("")
    : `<span class="chip empty">대기 중인 관전자 없음</span>`;
}

// ---------- 대기열 칩: 초록불 / 자리 교체 ----------
let swapArm = null; // { target, timer } — 내 칸에 글이 남아 있어 "한 번 더" 기다리는 중
function disarmSwap() {
  if (!swapArm) return;
  clearTimeout(swapArm.timer);
  swapArm = null;
  const el = document.querySelector(".chip.armed");
  if (el) el.classList.remove("armed");
}

$("queue-list").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-chip]");
  if (!chip || !state || !me) return;
  const target = Number(chip.dataset.chip);
  const t = state.seats[target];
  const mine = state.seats[me.seat];
  if (!t || !mine) return;

  if (mine.role === "spectator") {
    if (target === me.seat) socket.emit("toggle_ready"); // 다른 사람 칩은 못 누름
    return;
  }
  if (mine.role !== "worker" || !t.ready) return; // 초록불 꺼진 칩 → 아무 일 없음

  if (swapArm && swapArm.target === target) {
    disarmSwap();
    socket.emit("swap", { target, confirm: true });
  } else {
    disarmSwap();
    emitText(); // 내 칸 최신 글을 먼저 보내서 서버가 정확히 판단하게
    socket.emit("swap", { target, confirm: false });
  }
});

// 서버: 내 칸에 송출 안 된 글이 있으니 한 번 더 눌러야 바꿔요
socket.on("swap_confirm", (d) => {
  disarmSwap();
  swapArm = { target: d.target, timer: setTimeout(disarmSwap, 4000) };
  const el = document.querySelector(`[data-chip="${d.target}"]`);
  if (el) el.classList.add("armed");
  toast("입력칸에 송출 안 된 글이 있어요. 한 번 더 누르면 교체 (남은 글은 삭제)");
});

document.querySelector(".writers").addEventListener("click", (e) => {
  if (e.target.closest("[data-pass]")) passTurn();
});

$("leave-btn").addEventListener("click", () => socket.emit("leave"));
$("me-rename").addEventListener("click", () => {
  const cur = state.seats[me.seat].name;
  const name = window.prompt("바꿀 이름을 입력하세요 (최대 12자)", cur);
  if (name && name.trim() && name.trim() !== cur) socket.emit("rename", { seat: me.seat, name });
});
