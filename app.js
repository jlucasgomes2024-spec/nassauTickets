const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let currentServing = null;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.style.display = "block";
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => el.style.display = "none", 2800);
}

function formatState(s) {
  return ({
    EMITIDA: "Emitida",
    AGUARDANDO: "Aguardando",
    CHAMADA: "Chamada",
    CHAMADA_NOVAMENTE: "Chamada novamente",
    EM_ATENDIMENTO: "Em atendimento",
    ATENDIDA: "Atendida",
    NAO_COMPARECEU: "Não compareceu"
  })[s] || s;
}

async function api(url, options={}) {
  const res = await fetch(url, {
    headers: {"Content-Type": "application/json"},
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro na operação.");
  return data;
}

$$(".tab").forEach(btn => {
  btn.onclick = () => {
    $$(".tab").forEach(x => x.classList.remove("active"));
    $$(".view").forEach(x => x.classList.remove("active"));
    btn.classList.add("active");
    $("#" + btn.dataset.tab).classList.add("active");
    refresh();
  };
});

$$(".ticket-button").forEach(btn => {
  btn.onclick = async () => {
    try {
      const ticket = await api("/api/tickets", {
        method: "POST",
        body: JSON.stringify({type: btn.dataset.type})
      });
      const issued = $("#issued");
      issued.classList.remove("hidden");
      issued.innerHTML = `
        <div>Senha emitida</div>
        <div class="code">${ticket.code}</div>
        <div>${ticket.type === "SP" ? "Prioritária" : ticket.type === "SE" ? "Retirada de Exames" : "Geral"}</div>
      `;
      toast(`Senha ${ticket.code} emitida.`);
      refresh();
    } catch (e) { toast(e.message); }
  };
});

$("#callNext").onclick = async () => {
  try {
    const ticket = await api("/api/call-next", {
      method: "POST",
      body: JSON.stringify({counter: $("#counter").value || "G1"})
    });
    currentServing = ticket.ticket;
    renderCurrent();
    toast(ticket.message);
    refresh();
  } catch (e) { toast(e.message); }
};

async function startTicket(id) {
  try {
    currentServing = await api(`/api/tickets/${id}/start`, {method:"POST"});
    renderCurrent();
    refresh();
  } catch(e) { toast(e.message); }
}

async function finishTicket(id) {
  try {
    await api(`/api/tickets/${id}/finish`, {method:"POST"});
    currentServing = null;
    renderCurrent();
    toast("Atendimento finalizado.");
    refresh();
  } catch(e) { toast(e.message); }
}

async function noShow(id) {
  try {
    await api(`/api/tickets/${id}/no-show`, {method:"POST"});
    currentServing = null;
    renderCurrent();
    toast("Senha marcada como não compareceu.");
    refresh();
  } catch(e) { toast(e.message); }
}

function renderCurrent() {
  const el = $("#current");
  if (!currentServing) {
    el.innerHTML = `<div class="empty">Nenhuma senha selecionada para o atendimento.</div>`;
    return;
  }
  const t = currentServing;
  const start = t.state === "EM_ATENDIMENTO";
  el.innerHTML = `
    <div class="current-card">
      <div>Guichê: <strong>${t.counter || "—"}</strong></div>
      <div class="current-code">${t.code}</div>
      <div><span class="badge">${formatState(t.state)}</span> · ${t.calls} chamada(s)</div>
      <div class="actions">
        ${!start ? `<button onclick="startTicket(${t.id})">Iniciar atendimento</button>` : ""}
        ${start ? `<button onclick="finishTicket(${t.id})">Finalizar atendimento</button>` : ""}
        ${t.calls >= 2 && !start ? `<button onclick="noShow(${t.id})">Não compareceu</button>` : ""}
      </div>
    </div>`;
}

function renderWaiting(waiting) {
  $("#waitingList").innerHTML = `
    <h3>Fila de espera</h3>
    <div class="waiting">
      ${waiting.length ? waiting.map(t => `
        <div class="queue-item">
          <div><span class="queue-code">${t.code}</span><br><span class="badge">${t.type}</span></div>
          <span>${formatState(t.state)} · ${t.calls} chamada(s)</span>
        </div>`).join("") : `<div class="empty">Fila vazia.</div>`}
    </div>`;
}

function renderPanel(calls) {
  const last = calls[0];
  $("#bigLast").textContent = last ? `${last.code} · ${last.counter || ""}` : "—";
  $("#panelList").innerHTML = calls.map(c =>
    `<div>${c.code}<br><small>${c.counter || "—"}</small></div>`
  ).join("");
}

function renderSystem(data) {
  const s = data.stats || {};
  $("#stats").innerHTML = `
    <div class="stat">Total<strong>${s.total || 0}</strong></div>
    <div class="stat">Atendidas<strong>${s.atendidas || 0}</strong></div>
    <div class="stat">Não compareceram<strong>${s.nao_compareceram || 0}</strong></div>
    <div class="stat">Pendentes<strong>${s.pendentes || 0}</strong></div>`;

  $("#systemQueue").innerHTML = data.waiting.length
    ? data.waiting.map(t => `<div class="queue-item"><strong>${t.code}</strong><span>${t.type} · ${formatState(t.state)}</span></div>`).join("")
    : `<div class="empty">Nenhuma senha na fila.</div>`;

  $("#systemServing").innerHTML = data.serving.length
    ? data.serving.map(t => `<div class="queue-item"><strong>${t.code}</strong><span>${t.counter || "—"}</span></div>`).join("")
    : `<div class="empty">Nenhum atendimento em andamento.</div>`;
}

async function refresh() {
  try {
    const data = await api("/api/state");
    renderWaiting(data.waiting);
    renderPanel(data.lastCalls);
    renderSystem(data);
  } catch (e) {
    console.error(e);
  }
}

$("#closeDay").onclick = async () => {
  if (!confirm("Encerrar o expediente? As senhas ainda pendentes serão descartadas.")) return;
  try {
    const result = await api("/api/close-day", {method:"POST"});
    currentServing = null;
    renderCurrent();
    toast(`${result.discarded} senha(s) descartada(s).`);
    refresh();
  } catch(e) { toast(e.message); }
};

function updateClock() {
  $("#clock").textContent = new Date().toLocaleString("pt-BR");
}
setInterval(updateClock, 1000);
updateClock();
renderCurrent();
refresh();
setInterval(refresh, 3000);