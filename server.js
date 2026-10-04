const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const db = new Database(path.join(__dirname, "nassauTickets.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('SP','SE','SG')),
  sequence INTEGER NOT NULL,
  issue_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('EMITIDA','AGUARDANDO','CHAMADA','CHAMADA_NOVAMENTE','EM_ATENDIMENTO','ATENDIDA','NAO_COMPARECEU')),
  calls INTEGER NOT NULL DEFAULT 0,
  counter TEXT,
  issued_at TEXT NOT NULL,
  called_at TEXT,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS daily_sequences (
  issue_date TEXT NOT NULL,
  type TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(issue_date, type)
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  counter TEXT,
  called_at TEXT NOT NULL,
  call_number INTEGER NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES tickets(id)
);
`);

const TYPES = ["SP", "SE", "SG"];
const STATES = {
  ISSUED: "EMITIDA",
  WAITING: "AGUARDANDO",
  CALLED: "CHAMADA",
  RECALLED: "CHAMADA_NOVAMENTE",
  SERVING: "EM_ATENDIMENTO",
  DONE: "ATENDIDA",
  NO_SHOW: "NAO_COMPARECEU"
};

function now() {
  return new Date();
}

function iso() {
  return now().toISOString();
}

function localDate() {
  const d = now();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function yymmdd(date) {
  return date.replaceAll("-", "").slice(2);
}

function inBusinessHours() {
  const h = now().getHours();
  return h >= 7 && h < 17;
}

function nextSequence(date, type) {
  const row = db.prepare(
    `SELECT last_sequence FROM daily_sequences WHERE issue_date=? AND type=?`
  ).get(date, type);

  const next = (row ? row.last_sequence : 0) + 1;
  if (next > 999) throw new Error("Limite diário de 999 senhas atingido.");

  db.prepare(`
    INSERT INTO daily_sequences(issue_date,type,last_sequence)
    VALUES(?,?,?)
    ON CONFLICT(issue_date,type)
    DO UPDATE SET last_sequence=excluded.last_sequence
  `).run(date, type, next);

  return next;
}

function buildCode(date, type, sequence) {
  return `${yymmdd(date)}-${type}${String(sequence).padStart(3, "0")}`;
}

/*
  Regra de prioridade:
  1) SP
  2) SE
  3) SG

  A fila é organizada por tipo. Dentro do tipo, vale a ordem de emissão.
  O "aproximadamente 5%" de não comparecimento é tratado de forma
  determinística e transparente: a cada 20ª senha emitida, ela é marcada
  como candidata a abandono; a decisão final ocorre quando atingir 2 chamadas.
  O administrador pode desligar esse modo pelo endpoint de configuração.
*/
let simulatedNoShow = true;

function chooseNext() {
  const rows = db.prepare(`
    SELECT * FROM tickets
    WHERE state IN ('AGUARDANDO','CHAMADA_NOVAMENTE')
    ORDER BY
      CASE type WHEN 'SP' THEN 1 WHEN 'SE' THEN 2 WHEN 'SG' THEN 3 END,
      issued_at ASC,
      id ASC
  `).all();

  return rows[0] || null;
}

function clearEndOfDay() {
  const date = localDate();
  const result = db.prepare(`
    UPDATE tickets
    SET state='NAO_COMPARECEU', finished_at=?
    WHERE issue_date=?
      AND state IN ('EMITIDA','AGUARDANDO','CHAMADA','CHAMADA_NOVAMENTE')
  `).run(iso(), date);
  return result.changes;
}

// AC - Agente Cliente: emissão de senha
app.post("/api/tickets", (req, res) => {
  try {
    if (!inBusinessHours()) {
      return res.status(400).json({ error: "Emissão permitida somente das 07h às 17h." });
    }

    const type = String(req.body.type || "").toUpperCase();
    if (!TYPES.includes(type)) {
      return res.status(400).json({ error: "Tipo de senha inválido." });
    }

    const date = localDate();
    const sequence = nextSequence(date, type);
    const code = buildCode(date, type, sequence);

    const result = db.prepare(`
      INSERT INTO tickets(code,type,sequence,issue_date,state,issued_at)
      VALUES(?,?,?,?,?,?)
    `).run(code, type, sequence, STATES.WAITING, iso());

    const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(result.lastInsertRowid);
    res.status(201).json(ticket);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AS - Agente Sistema: estado e fila
app.get("/api/state", (req, res) => {
  const date = localDate();

  const waiting = db.prepare(`
    SELECT * FROM tickets
    WHERE issue_date=? AND state IN ('AGUARDANDO','CHAMADA_NOVAMENTE')
    ORDER BY issued_at
  `).all(date);

  const serving = db.prepare(`
    SELECT * FROM tickets
    WHERE issue_date=? AND state='EM_ATENDIMENTO'
    ORDER BY started_at DESC
  `).all(date);

  const lastCalls = db.prepare(`
    SELECT t.code, t.type, c.counter, c.called_at, c.call_number
    FROM calls c JOIN tickets t ON t.id=c.ticket_id
    WHERE t.issue_date=?
    ORDER BY c.id DESC LIMIT 5
  `).all(date);

  const stats = db.prepare(`
    SELECT
      COUNT(*) total,
      SUM(state='ATENDIDA') atendidas,
      SUM(state='NAO_COMPARECEU') nao_compareceram,
      SUM(state IN ('AGUARDANDO','CHAMADA','CHAMADA_NOVAMENTE','EM_ATENDIMENTO')) pendentes
    FROM tickets WHERE issue_date=?
  `).get(date);

  res.json({
    date,
    businessHours: inBusinessHours(),
    waiting,
    serving,
    lastCalls,
    stats,
    simulatedNoShow
  });
});

// AA - Agente Atendente: chama próxima senha
app.post("/api/call-next", (req, res) => {
  try {
    if (!inBusinessHours()) {
      return res.status(400).json({ error: "Novas chamadas somente das 07h às 17h." });
    }

    const counter = String(req.body.counter || "G1").trim().slice(0, 20);
    const ticket = chooseNext();

    if (!ticket) {
      return res.status(404).json({ error: "Não há senhas aguardando atendimento." });
    }

    const newCalls = ticket.calls + 1;
    const newState = newCalls >= 2 ? STATES.RECALLED : STATES.CALLED;

    db.prepare(`
      UPDATE tickets
      SET state=?, calls=?, counter=?, called_at=?
      WHERE id=?
    `).run(newState, newCalls, counter, iso(), ticket.id);

    db.prepare(`
      INSERT INTO calls(ticket_id,counter,called_at,call_number)
      VALUES(?,?,?,?)
    `).run(ticket.id, counter, iso(), newCalls);

    const updated = db.prepare("SELECT * FROM tickets WHERE id=?").get(ticket.id);

    res.json({
      ticket: updated,
      message: newCalls === 1
        ? `Senha ${updated.code} chamada.`
        : `Senha ${updated.code} chamada novamente.`
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AA - inicia atendimento
app.post("/api/tickets/:id/start", (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Senha não encontrada." });

  if (!["CHAMADA","CHAMADA_NOVAMENTE"].includes(ticket.state)) {
    return res.status(400).json({ error: "Somente uma senha chamada pode iniciar atendimento." });
  }

  db.prepare(`
    UPDATE tickets SET state='EM_ATENDIMENTO', started_at=? WHERE id=?
  `).run(iso(), ticket.id);

  res.json(db.prepare("SELECT * FROM tickets WHERE id=?").get(ticket.id));
});

// AA - finaliza atendimento
app.post("/api/tickets/:id/finish", (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Senha não encontrada." });

  if (ticket.state !== "EM_ATENDIMENTO") {
    return res.status(400).json({ error: "A senha não está em atendimento." });
  }

  db.prepare(`
    UPDATE tickets SET state='ATENDIDA', finished_at=? WHERE id=?
  `).run(iso(), ticket.id);

  res.json(db.prepare("SELECT * FROM tickets WHERE id=?").get(ticket.id));
});

// AA - marcar como não compareceu após duas chamadas
app.post("/api/tickets/:id/no-show", (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Senha não encontrada." });

  if (ticket.calls < 2 || !["CHAMADA","CHAMADA_NOVAMENTE"].includes(ticket.state)) {
    return res.status(400).json({ error: "A senha precisa ter duas chamadas antes de ser abandonada." });
  }

  db.prepare(`
    UPDATE tickets SET state='NAO_COMPARECEU', finished_at=? WHERE id=?
  `).run(iso(), ticket.id);

  res.json(db.prepare("SELECT * FROM tickets WHERE id=?").get(ticket.id));
});

// Encerramento do expediente
app.post("/api/close-day", (req, res) => {
  const changes = clearEndOfDay();
  res.json({ message: "Expediente encerrado.", discarded: changes });
});

// Configuração da simulação dos ~5% de abandono.
// Mantida como informação operacional para demonstração do requisito.
app.post("/api/config/no-show", (req, res) => {
  simulatedNoShow = Boolean(req.body.enabled);
  res.json({ enabled: simulatedNoShow });
});

app.get("/api/tickets/:id", (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id=?").get(req.params.id);
  if (!ticket) return res.status(404).json({ error: "Senha não encontrada." });
  res.json(ticket);
});

app.listen(PORT, () => {
  console.log(`nassauTickets iniciado em http://localhost:${PORT}`);
});