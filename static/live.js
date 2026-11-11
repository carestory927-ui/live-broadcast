// 실시간 방송 자막 — 화면 로직 (입장 / 입력 공유 / 턴 / 송출 이력 / 단축키)
const socket = io();
const STORE_KEY = "live_me";

let state = null;          // 서버가 보내주는 전체 상태
let me = loadMe();         // { seat, token } — 새로고침해도 같은 자리로 복귀
let joined = false;        // 서버가 입장을 확인했는지
let editingSeat = null;    // 메인 화면에서 이름 수정 중인 자리

// 입력칸 / 송출 이력
const boxes = new Map();   // 자리 번호 → textarea (한 번 만들면 계속 재사용 → 커서·조합 유지)
const texts = {};          // 자리 번호 → 서버가 알려준 글 (상대·관전용 표시)
let myExt = 0;             // 내 칸에 대해 서버가 잘라낸 버전 중 내가 반영한 마지막 번호
let pendingOps = [];       // 한글 조합 중이라 아직 반영 못 한 잘라내기
let composing = false;     // 내 칸에서 한글 조합 중인지
let historyText = "";
const marks = {};          // 자리 번호 → 노란 줄 [[줄 시작, 그 줄의 \n 위치], ...]
let lastValue = "";        // 마지막으로 노란 줄 위치를 맞춘 시점의 내 칸 글

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const roleText = (r) => (r === "worker" ? "작업자" : r === "spectator" ? "관전자" : "");
const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 30;

function loadMe() {
  try { return JSON.parse(sessionStorage.getItem(STORE_KEY)); } catch { return null; }
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

function resetRoomLocal() {
  boxes.clear();
  for (const k of Object.keys(texts)) delete texts[k];
  for (const k of Object.keys(marks)) delete marks[k];
  lastValue = "";
  myExt = 0;
  pendingOps = [];
  composing = false;
  for (let i = 0; i < 2; i++) { const el = $(`writer-${i}`); if (el) { delete el.dataset.seat; el.innerHTML = ""; } }
}

// ---------- 서버 이벤트 ----------
socket.on("connect", () => {
  $("conn").classList.add("hidden");
  if (me) socket.emit("join", { seat: me.seat, token: me.token });
});
socket.on("disconnect", () => $("conn").classList.remove("hidden"));
socket.on("state", (s) => { state = s; render(); });
socket.on("joined", (d) => {
  const localBox = boxes.get(d.seat); // 있으면: 새로고침이 아니라 잠깐 끊겼다 재연결된 것
  saveMe({ seat: d.seat, token: d.token });
  joined = true;

  const myLocalMarks = marks[d.seat];
  for (const k of Object.keys(texts)) delete texts[k];
  for (const k of Object.keys(marks)) delete marks[k];
  for (const [seat, t] of Object.entries(d.texts || {})) { texts[seat] = t.text; marks[seat] = t.marks || []; }
  const mine = (d.texts || {})[d.seat];
  if (mine && localBox) {
    // 끊긴 동안 친 글·노란 줄은 살리고, 그동안 서버가 잘라낸 것(F1/F8)만 똑같이 반영
    marks[d.seat] = myLocalMarks || [];
    pendingOps = (d.my_ops || []).map(([ext, removed, kind]) => ({ ext, removed, kind, text: mine.text, marks: mine.marks || [] }));
    applyPendingOps(true);
    myExt = Math.max(myExt, mine.ext);
  } else if (mine) {
    myExt = mine.ext; // 새로고침 → 서버에 남아 있던 글·노란 줄로 칸을 채워요 (render에서)
  }
  for (const [seat, ta] of boxes) if (Number(seat) !== d.seat) setBoxText(ta, texts[seat] || "");

  setHistory(d.history || "");
  render();
});
socket.on("join_error", (d) => {
  if (d.clear) { saveMe(null); joined = false; resetRoomLocal(); }
  toast(d.message);
  render();
});
socket.on("left", () => { saveMe(null); joined = false; resetRoomLocal(); render(); });
socket.on("toast", (d) => toast(d.message));

// 다른 작업자가 입력한 글 (자기 칸 글은 서버가 나에게 다시 보내지 않아요)
socket.on("text", (d) => {
  if (joined && me && d.seat === me.seat) return;
  texts[d.seat] = d.text;
  marks[d.seat] = d.marks || [];
  const ta = boxes.get(d.seat);
  if (ta) setBoxText(ta, d.text);
});

// 서버가 어떤 칸의 첫 어절을 잘라냄 (F1 송출 또는 F8 삭제)
socket.on("cut", (d) => {
  if (joined && me && d.seat === me.seat && myBox()) {
    pendingOps.push(d);
    if (!composing) applyPendingOps();
    return;
  }
  texts[d.seat] = d.text;
  marks[d.seat] = d.marks || [];
  const ta = boxes.get(d.seat);
  if (ta) setBoxText(ta, d.text);
});

socket.on("history_append", (d) => appendHistory(d.chunk));
socket.on("history_full", (d) => setHistory(d.history || ""));

// ---------- 입력칸 ----------
// 내 칸 글이 바뀔 때마다 호출: 노란 줄 위치를 맞추고 서버로 보내요.
// lineBreak=true → 방금 Enter로 끝낸 줄을 노란 줄로 표시 (턴이 없을 때만 호출됨)
function emitText(lineBreak = false) {
  const ta = myBox();
  if (!ta) return;
  const seat = me.seat;
  const v = ta.value;
  let ms = marks[seat] || [];
  if (v !== lastValue) {
    const caret = ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null;
    ms = shiftMarks(ms, lastValue, v, caret);
    lastValue = v;
  }
  if (lineBreak === true) {
    const k = ta.selectionStart - 1;          // 방금 들어간 줄바꿈 위치
    if (v[k] === "\n") {
      const a = k > 0 ? v.lastIndexOf("\n", k - 1) + 1 : 0;
      if (v.slice(a, k).trim()) ms = ms.concat([[a, k]]);
    }
  }
  marks[seat] = validMarks(ms, v);
  paintMarks(seat);
  socket.emit("text", { text: v, ext: myExt, marks: marks[seat] });
}

function onMyInput(e) {
  emitText(e.inputType === "insertLineBreak" && !amMain());
}

// ---------- 노란 줄 위치 계산 ----------
// 글이 oldV → newV로 바뀌었을 때: 바뀐 곳이 노란 줄을 건드렸으면 표시를 없애고, 뒤쪽 줄은 위치만 옮겨요.
// caret(바뀐 뒤 커서)을 쓰면 "같은 글자가 반복될 때 어디가 바뀐 건지"를 정확히 알 수 있어요.
function shiftMarks(ms, oldV, newV, caret) {
  if (!ms.length) return ms;
  let p = 0, s = -1;
  if (caret != null) {
    const tail = newV.length - caret;
    if (tail <= oldV.length && oldV.endsWith(newV.slice(caret))) s = tail;
  }
  if (s >= 0) {
    const maxP = Math.min(oldV.length, newV.length) - s;
    while (p < maxP && oldV[p] === newV[p]) p++;
  } else {
    const max = Math.min(oldV.length, newV.length);
    while (p < max && oldV[p] === newV[p]) p++;
    s = 0;
    while (s < max - p && oldV[oldV.length - 1 - s] === newV[newV.length - 1 - s]) s++;
  }
  const oldEnd = oldV.length - s;             // 예전 글에서 바뀐 구간 [p, oldEnd)
  const delta = newV.length - oldV.length;
  const out = [];
  for (const [a, b] of ms) {
    const touched = p === oldEnd
      ? a <= p && p <= b                      // 끼워 넣기: 줄 맨 앞~줄 끝(\n 앞) 사이면 수정
      : p <= b && oldEnd >= a;                // 지우기/바꾸기: 줄 또는 앞뒤 줄바꿈과 겹치면 수정
    if (touched) continue;
    out.push(b < p ? [a, b] : [a + delta, b + delta]);
  }
  return out;
}

// 앞에서 n글자를 잘라냈을 때 (서버 app.py의 cut_marks와 같은 규칙)
function cutMarks(ms, n, kind) {
  const out = [];
  for (const [a, b] of ms || []) {
    if (a >= n) out.push([a - n, b - n]);
    else if (kind === "send" && n < b) out.push([0, b - n]); // 송출로 앞부분만 나간 줄은 남은 부분 유지
  }
  return out;
}

function validMarks(ms, v) {
  const seen = new Set();
  return (ms || []).filter(([a, b]) => {
    const ok = 0 <= a && a < b && b < v.length && v[b] === "\n" && (a === 0 || v[a - 1] === "\n")
      && !v.slice(a, b).includes("\n") && !seen.has(a);
    if (ok) seen.add(a);
    return ok;
  }).sort((x, y) => x[0] - y[0]);
}

// textarea 뒤 배경 레이어에 노란 줄을 그려요 (글꼴·줄간격·패딩·폭·스크롤을 textarea와 똑같이)
function paintMarks(seat) {
  const ta = boxes.get(Number(seat));
  if (!ta) return;
  const hl = ta.previousElementSibling;
  if (!hl || !hl.classList.contains("box-hl")) return;
  const ms = marks[seat] || [];
  if (!ms.length) {
    if (hl.firstChild) hl.textContent = "";
    return;
  }
  const on = new Set(ms.map((m) => m[0]));
  let html = "", pos = 0;
  for (const line of ta.value.split("\n")) {
    html += `<div class="hl-line${on.has(pos) ? " on" : ""}">${line ? esc(line) : "&#8203;"}</div>`;
    pos += line.length + 1;
  }
  hl.innerHTML = html;
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
  paintMarks(ta.dataset.seat);
}

// 내 칸에 서버의 잘라내기를 반영 — 커서는 잘린 글자 수만큼 앞으로 당겨서 유지
function applyPendingOps(force = false) {
  const ta = myBox();
  if (!ta) { pendingOps = []; return; }
  const ops = pendingOps.filter((op) => op.ext > myExt);
  pendingOps = [];
  if (!ops.length && !force) return;

  // 먼저 지금까지 친 글 기준으로 노란 줄 위치를 맞춰 두고
  if (ta.value !== lastValue) {
    const caret = ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null;
    marks[me.seat] = shiftMarks(marks[me.seat] || [], lastValue, ta.value, caret);
  }
  let val = ta.value;
  let ms = marks[me.seat] || [];
  let s = ta.selectionStart, e = ta.selectionEnd;
  for (const op of ops) {
    const n = op.removed.length;
    if (val.startsWith(op.removed)) {
      val = val.slice(n);
      ms = cutMarks(ms, n, op.kind);
    } else {
      val = op.text; // 앞부분이 달라졌으면 서버 글을 따름
      ms = op.marks || [];
    }
    s = Math.max(0, s - n);
    e = Math.max(0, e - n);
    myExt = op.ext;
  }
  if (ops.length) {
    const top = ta.scrollTop;
    ta.value = val;
    ta.setSelectionRange(Math.min(s, val.length), Math.min(e, val.length));
    ta.scrollTop = top;
  }
  marks[me.seat] = ms;
  lastValue = ta.value; // 잘라내기는 위에서 정확히 반영했으니 다시 비교하지 않음
  emitText(); // 서버와 최종 글을 맞춰요 (버전도 최신으로)
}

function getBox(seatId, isMe) {
  let ta = boxes.get(seatId);
  if (ta) return ta;
  ta = document.createElement("textarea");
  ta.dataset.seat = seatId;
  ta.spellcheck = false;
  ta.value = texts[seatId] || "";
  // 노란 줄은 textarea 뒤에 겹친 배경 레이어(div)에 그려요
  const wrap = document.createElement("div");
  wrap.className = isMe ? "box-wrap" : "box-wrap ro";
  const hl = document.createElement("div");
  hl.className = "box-hl";
  hl.setAttribute("aria-hidden", "true");
  wrap.append(hl, ta);
  ta.addEventListener("scroll", () => { hl.scrollTop = ta.scrollTop; });
  new ResizeObserver(() => paintMarks(seatId)).observe(ta);
  if (isMe) {
    lastValue = ta.value;
    ta.placeholder = "여기에 입력하세요";
    ta.addEventListener("input", onMyInput);
    ta.addEventListener("keydown", onMyKeydown);
    ta.addEventListener("keyup", onMyKeyup);
    ta.addEventListener("compositionstart", () => { composing = true; });
    ta.addEventListener("compositionend", () => {
      composing = false;
      setTimeout(() => { if (!composing && pendingOps.length) applyPendingOps(); }, 0);
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
  // 한글 조합 중엔 e.key가 "Process"일 수 있어서 물리 키(e.code)를 먼저 봐요
  const action = KEYS[e.code] || KEYS[e.key];
  if (!action) return;
  // Shift+Insert(붙여넣기), Ctrl+Insert(복사), Alt+F4 등 조합키는 그대로 둬요
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat && NO_REPEAT.has(action)) return;

  const ta = e.currentTarget;
  if (composing || e.isComposing || e.keyCode === 229) {
    commitComposition(ta).then(() => runAction(action, ta));
  } else {
    runAction(action, ta);
  }
}

// 조합 중인 한글을 확정시켜요: 포커스를 잠깐 뺐다 돌려주면 크롬이 조합을 끝내요
function commitComposition(ta) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ta.removeEventListener("compositionend", onEnd);
      composing = false;
      if (pendingOps.length) applyPendingOps();
      resolve();
    };
    const onEnd = () => setTimeout(finish, 0);
    ta.addEventListener("compositionend", onEnd);
    ta.blur();
    ta.focus();
    setTimeout(finish, 60); // compositionend가 안 오더라도 계속 진행
  });
}

// 윈도우 크롬은 F10을 "손을 뗄 때" 메뉴 이동으로 처리할 수 있어서 keyup도 막아요
function onMyKeyup(e) {
  if ((e.code === "F10" || e.key === "F10") && !(e.ctrlKey || e.altKey || e.metaKey || e.shiftKey)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

const SERVER_ACTIONS = new Set(["send", "delPartner", "pass"]);

function runAction(action, ta) {
  if (!amWorker()) return;
  // 내 칸만 고치는 동작(F3/F4/F10/F12)은 끊겨 있어도 돼요 — 재연결 때 내 글이 서버로 다시 가요
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
      socket.emit("send_word");
      break;
    case "delLast": {
      const v = ta.value;
      const nv = v.replace(/\S+\s*$/, "");
      if (nv === v) return;
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
      if (!ta.value) return;
      ta.value = "";
      emitText();
      break;
    case "pass":
      if (!amMain()) return toast("작성중일 때만 턴을 넘길 수 있어요.");
      socket.emit("pass_turn");
      break;
  }
}

// ---------- 상용구 (이 브라우저의 localStorage에 저장) ----------
const PHRASE_KEY = "live_phrases";
let phrases = loadPhrases();   // { 입력어: 출력어 }

function loadPhrases() {
  try {
    const v = JSON.parse(localStorage.getItem(PHRASE_KEY));
    // 프로토타입 없는 객체 → "__proto__" 같은 입력어도 안전
    const obj = Object.create(null);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, out] of Object.entries(v)) if (typeof out === "string") obj[k] = out;
    }
    return obj;
  } catch { return Object.create(null); }
}
function savePhrases() {
  try { localStorage.setItem(PHRASE_KEY, JSON.stringify(phrases)); }
  catch { toast("상용구를 저장하지 못했어요. (브라우저 저장소를 쓸 수 없음)"); }
  renderPhraseList();
}
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

  const m = line.match(/^\s*([^:：\s]+)\s*[:：](.*)$/); // 반각·전각 콜론 둘 다 허용
  const out = m ? m[2].trim() : "";
  if (!m || !out) {
    return toast("상용구 형식: 한 줄에 입력어:출력어 (예: 굿:굿 굿즈) — 입력어는 띄어쓰기 없이");
  }
  const key = m[1];
  const replaced = hasPhrase(key) && phrases[key] !== out;
  phrases[key] = out;
  savePhrases();

  // 줄과 그 줄바꿈 하나를 같이 지움 (마지막 줄이면 앞 줄바꿈을 지움)
  let cutStart = start, cutEnd = end;
  if (end < v.length) cutEnd = end + 1;
  else if (start > 0) cutStart = start - 1;
  setMyText(ta, v.slice(0, cutStart) + v.slice(cutEnd), cutStart);
  toast(`상용구 ${replaced ? "덮어씀" : "등록"}: ${key} → ${out}`);
}

// F3: 커서 바로 앞 어절이 입력어면 출력어로 바꿔요
function expandPhrase(ta) {
  const v = ta.value;
  const pos = ta.selectionEnd;
  const m = v.slice(0, pos).match(/\S+$/);
  if (!m) return toast("커서 바로 앞에 어절이 없어요.");
  const key = m[0];
  if (!hasPhrase(key)) return toast(`'${key}'은(는) 등록된 상용구가 아니에요.`);
  const out = phrases[key];
  const start = pos - key.length;
  setMyText(ta, v.slice(0, start) + out + v.slice(pos), start + out.length);
}

function renderPhraseList() {
  const keys = Object.keys(phrases).sort((a, b) => a.localeCompare(b, "ko"));
  $("phrase-count").textContent = `${keys.length}개`;
  $("phrase-list").innerHTML = keys.length
    ? keys.map((k) => `<li>
        <span class="p-key" title="${esc(k)}">${esc(k)}</span><span class="p-arrow">→</span>
        <span class="p-out">${esc(phrases[k])}</span>
        <button class="icon-btn" data-del-phrase="${esc(k)}" title="삭제">🗑️</button></li>`).join("")
    : `<li class="empty">등록된 상용구가 없어요</li>`;
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
    delete phrases[k];
    savePhrases();
    toast(`상용구 삭제: ${k}`);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("phrase-modal").classList.contains("hidden")) closePhrases();
});
// 같은 브라우저의 다른 탭에서 등록·삭제하면 이 탭에도 반영
window.addEventListener("storage", (e) => {
  if (e.key !== PHRASE_KEY) return;
  phrases = loadPhrases();
  renderPhraseList();
});

// ---------- 방송 영상 (YouTube IFrame Player API, 내 화면에서만) ----------
const YT_STORE_KEY = "live_yt_url";
let ytPlayer = null;       // YT.Player
let ytReady = false;       // 플레이어 준비 완료
let ytVideoId = null;      // 지금 열린 영상
let ytApiPromise = null;

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

async function openYouTube(raw) {
  const v = parseYouTube(raw);
  if (!v) return toast("유튜브 링크 형식이 아니에요. (watch?v= · youtu.be · /live/ · /shorts/)");
  try { sessionStorage.setItem(YT_STORE_KEY, raw.trim()); } catch {}
  $("yt-empty").classList.add("hidden");
  $("yt-wrap").classList.remove("hidden");
  try {
    await loadYouTubeApi();
  } catch {
    return toast("유튜브 플레이어를 불러오지 못했어요. 인터넷 연결을 확인해주세요.");
  }
  ytVideoId = v.id;
  if (ytPlayer && ytReady) {
    ytPlayer.loadVideoById({ videoId: v.id, startSeconds: v.start });
    return;
  }
  if (ytPlayer) return; // 아직 준비 중 — onReady에서 최신 ytVideoId를 열어요
  ytPlayer = new YT.Player("yt-player", {
    videoId: v.id,
    playerVars: { playsinline: 1, rel: 0, start: v.start, origin: location.origin },
    events: {
      onReady: () => {
        ytReady = true;
        if (ytPlayer.getVideoData && ytPlayer.getVideoData().video_id !== ytVideoId) ytPlayer.loadVideoById(ytVideoId);
      },
      onError: (e) => toast(YT_ERRORS[e.data] || `영상을 재생할 수 없어요. (오류 ${e.data})`),
    },
  });
}

$("yt-form").addEventListener("submit", (e) => {
  e.preventDefault();
  openYouTube($("yt-url").value);
});
try { $("yt-url").value = sessionStorage.getItem(YT_STORE_KEY) || ""; } catch {}

let flashTimer = null;
function seekBy(delta) {
  if (!ytPlayer || !ytReady || !ytVideoId || typeof ytPlayer.getCurrentTime !== "function") return; // 영상 없음 → 아무것도 안 함
  const dur = ytPlayer.getDuration() || 0;
  let t = Math.max(0, (ytPlayer.getCurrentTime() || 0) + delta);
  if (dur > 0 && !isLive()) t = Math.min(t, Math.max(0, dur - 0.5));
  ytPlayer.seekTo(t, true);
  const f = $("yt-flash");
  f.textContent = delta < 0 ? `◀◀ ${-delta}초` : `${delta}초 ▶▶`;
  f.classList.remove("hidden");
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.add("hidden"), 600);
}
function isLive() {
  try { return !!(ytPlayer.getVideoData && ytPlayer.getVideoData().isLive); } catch { return false; }
}

// F7/F9: 어디에 포커스가 있든(입력칸 포함) 동작, 포커스는 건드리지 않아요.
// 캡처 단계에서 먼저 받아서 처리 — 크롬의 F7(캐럿 브라우징 안내창)도 막아요.
const SEEK_KEYS = { F7: -2, F9: 2 };
document.addEventListener("keydown", (e) => {
  const delta = SEEK_KEYS[e.code] ?? SEEK_KEYS[e.key];
  if (delta === undefined || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  if (joined) seekBy(delta);
}, true);

// 영상(iframe)을 클릭하면 키보드 포커스가 유튜브로 넘어가서 타이핑·단축키가 먹히지 않아요.
// 직전에 내 입력칸에 있었다면 바로 되돌려줘요 (커서 위치는 textarea가 기억).
let lastFocused = null;
document.addEventListener("focusin", (e) => { lastFocused = e.target; });
window.addEventListener("blur", () => {
  setTimeout(() => {
    const active = document.activeElement;
    const box = myBox();
    if (active && active.tagName === "IFRAME" && $("yt-wrap").contains(active) && box && lastFocused === box) {
      box.focus();
    }
  }, 0);
});

// ---------- 송출 이력 ----------
function setHistory(text) {
  historyText = text;
  const el = $("history");
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}
function appendHistory(chunk) {
  historyText += chunk;
  const el = $("history");
  const stick = nearBottom(el);
  el.appendChild(document.createTextNode(chunk));
  if (stick) el.scrollTop = el.scrollHeight;
}

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
  if (!state) return;
  const inRoom = joined && me && state.seats[me.seat] && state.seats[me.seat].taken;
  $("lobby").classList.toggle("hidden", inRoom);
  $("room").classList.toggle("hidden", !inRoom);
  if (inRoom) renderRoom(); else renderLobby();
}

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
    socket.emit("join", { seat: Number(join.dataset.join) });
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
      el.appendChild(getBox(w.id, isMe).parentElement); // textarea + 노란 줄 레이어
    }
    el.querySelector(".writer-head").innerHTML =
      `<span class="dot ${w.online ? "worker" : "offline"}"></span>
       <span class="who">${esc(w.name)}</span>${isMe ? '<span class="tag">(나)</span>' : ""}
       <span class="turn-tag ${isMain ? "on" : ""}">${isMain ? "작성중" : "대기중"}</span>
       ${w.online ? "" : '<span class="tag">연결 끊김</span>'}
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
  $("key-hint").classList.toggle("hidden", !worker);
  $("history-clear").classList.toggle("hidden", !worker);

  // 작업자 → 관전자로 바뀌었으면 내 칸 관련 상태 정리
  if (!worker) { pendingOps = []; composing = false; }
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
  if (e.target.closest("[data-pass]")) socket.emit("pass_turn");
});

$("leave-btn").addEventListener("click", () => socket.emit("leave"));
$("me-rename").addEventListener("click", () => {
  const cur = state.seats[me.seat].name;
  const name = window.prompt("바꿀 이름을 입력하세요 (최대 12자)", cur);
  if (name && name.trim() && name.trim() !== cur) socket.emit("rename", { seat: me.seat, name });
});
