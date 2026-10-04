# nassauTickets

Sistema de controle de atendimento de um Laboratório de Análises Clínicas.

## Tecnologias

- Node.js
- Express
- SQLite com better-sqlite3
- HTML5, CSS3 e JavaScript

## Agentes

### AS — Agente Sistema
Responsável por:
- persistência no banco;
- geração da sequência diária;
- controle dos estados;
- aplicação da prioridade;
- atualização do painel;
- encerramento do expediente.

### AA — Agente Atendente
Responsável por:
- chamar a próxima senha;
- iniciar o atendimento;
- finalizar o atendimento;
- registrar segunda chamada;
- registrar não comparecimento após duas chamadas.

### AC — Agente Cliente
Representado pelo totem:
- emissão de SP;
- emissão de SE;
- emissão de SG.

## Prioridade

A fila segue:

1. SP — Senha Prioritária
2. SE — Retirada de Exames
3. SG — Senha Geral

Dentro do mesmo tipo, a ordem de emissão é respeitada.

## Numeração

Formato:

`YYMMDD-PPSQ`

Exemplo:

`261001-SP001`

A sequência é independente por tipo e reinicia diariamente.

## Máquina de estados

`EMITIDA → AGUARDANDO → CHAMADA → EM_ATENDIMENTO → ATENDIDA`

Também é possível:

`CHAMADA → CHAMADA_NOVAMENTE → EM_ATENDIMENTO`

ou:

`CHAMADA_NOVAMENTE → NÃO_COMPARECEU`

Após duas chamadas, o atendente pode registrar o não comparecimento.

## Regra dos aproximadamente 5%

O projeto deixa habilitada uma configuração de simulação de não comparecimento para demonstração do requisito. A decisão operacional de abandono é feita pelo fluxo das duas chamadas, não por uma exclusão automática de senha.

## Expediente

- 07:00 às 17:00
- Novas senhas e novas chamadas são bloqueadas fora do expediente.
- Ao encerrar o expediente, senhas ainda pendentes são marcadas como `NAO_COMPARECEU`.

## Como executar

Instale o Node.js.

No terminal:

```bash
npm install
npm start
```

Depois abra:

`http://localhost:3000`

## Observação acadêmica

A aplicação foi estruturada para servir como base de um projeto acadêmico. Para produção, recomenda-se autenticação de atendentes, controle de permissões, logs, auditoria, testes automatizados e sincronização de horário do servidor.
