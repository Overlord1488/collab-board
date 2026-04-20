/**
 * Сервер коллаборативной доски
 * -----------------------------
 *  - REST: создание доски (POST /board), получение состояния (GET /board/:id)
 *  - WebSocket: подключение, синхронизация объектов в реальном времени
 *
 *  Хранение — in-memory (Map), перезапуск сервера сбрасывает состояние.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // лимит для картинок в data-URL

// ---------------------- Хранилище -----------------------------------------
/**
 * boards: Map<boardId, {
 *   id: string,
 *   objects: Map<objectId, object>,
 *   clients: Set<WebSocket>,
 *   createdAt: number
 * }>
 */
const boards = new Map();

function makeBoardId() {
  // короткий, удобный для URL
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function createBoard() {
  const id = makeBoardId();
  boards.set(id, {
    id,
    objects: new Map(),
    clients: new Set(),
    createdAt: Date.now(),
  });
  console.log(`[board] создана доска ${id}`);
  return id;
}

// ---------------------- REST API ------------------------------------------
app.post('/board', (req, res) => {
  const id = createBoard();
  res.status(201).json({ id });
});

app.get('/board/:id', (req, res) => {
  const board = boards.get(req.params.id);
  if (!board) return res.status(404).json({ error: 'Доска не найдена' });
  res.json({
    id: board.id,
    objects: Array.from(board.objects.values()),
    users: board.clients.size,
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, boards: boards.size });
});

// Статика клиента
app.use(express.static(path.join(__dirname, '..', 'client')));

// ---------------------- WebSocket -----------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(board, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of board.clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.currentBoard = null;
  ws.userId = randomUUID().slice(0, 6);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, { type: 'error', message: 'Некорректный JSON' });
    }

    switch (msg.type) {
      // ---- Подключение к доске -------------------------------------------
      case 'join-board': {
        const board = boards.get(msg.boardId);
        if (!board) {
          return send(ws, { type: 'error', message: 'Доска не найдена' });
        }
        // если уже был в другой — убираем
        if (ws.currentBoard && ws.currentBoard !== board) {
          ws.currentBoard.clients.delete(ws);
          broadcast(ws.currentBoard, {
            type: 'user-left',
            userCount: ws.currentBoard.clients.size,
          });
        }
        ws.currentBoard = board;
        board.clients.add(ws);

        send(ws, {
          type: 'board-state',
          boardId: board.id,
          userId: ws.userId,
          objects: Array.from(board.objects.values()),
          userCount: board.clients.size,
        });
        broadcast(
          board,
          { type: 'user-joined', userId: ws.userId, userCount: board.clients.size },
          ws,
        );
        console.log(`[ws] ${ws.userId} подключился к ${board.id} (всего: ${board.clients.size})`);
        break;
      }

      // ---- Создание объекта ----------------------------------------------
      case 'create-object': {
        const b = ws.currentBoard;
        if (!b || !msg.object) return;
        const obj = { ...msg.object, id: msg.object.id || randomUUID() };
        b.objects.set(obj.id, obj);
        broadcast(b, { type: 'create-object', object: obj, author: ws.userId });
        break;
      }

      // ---- Редактирование свойств ----------------------------------------
      case 'update-object': {
        const b = ws.currentBoard;
        if (!b || !msg.object || !msg.object.id) return;
        const existing = b.objects.get(msg.object.id);
        if (!existing) return;
        const updated = { ...existing, ...msg.object };
        b.objects.set(updated.id, updated);
        broadcast(b, { type: 'update-object', object: updated, author: ws.userId });
        break;
      }

      // ---- Перемещение ---------------------------------------------------
      case 'move-object': {
        const b = ws.currentBoard;
        if (!b || !msg.id) return;
        const existing = b.objects.get(msg.id);
        if (!existing) return;
        if (typeof msg.x === 'number') existing.x = msg.x;
        if (typeof msg.y === 'number') existing.y = msg.y;
        // для линии — второй конец
        if (typeof msg.x2 === 'number') existing.x2 = msg.x2;
        if (typeof msg.y2 === 'number') existing.y2 = msg.y2;
        broadcast(b, {
          type: 'move-object',
          id: msg.id,
          x: existing.x,
          y: existing.y,
          x2: existing.x2,
          y2: existing.y2,
          author: ws.userId,
        });
        break;
      }

      // ---- Удаление ------------------------------------------------------
      case 'delete-object': {
        const b = ws.currentBoard;
        if (!b || !msg.id) return;
        b.objects.delete(msg.id);
        broadcast(b, { type: 'delete-object', id: msg.id, author: ws.userId });
        break;
      }

      default:
        send(ws, { type: 'error', message: `Неизвестный тип: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    const b = ws.currentBoard;
    if (!b) return;
    b.clients.delete(ws);
    broadcast(b, { type: 'user-left', userId: ws.userId, userCount: b.clients.size });
    console.log(`[ws] ${ws.userId} отключился от ${b.id} (осталось: ${b.clients.size})`);
  });
});

// ---------------------- Запуск --------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎨  Collab Board запущен: http://localhost:${PORT}\n`);
});
