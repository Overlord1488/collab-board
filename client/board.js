/**
 * Клиентская логика коллаборативной доски.
 *  - WebSocket для синхронизации
 *  - SVG как холст
 *  - 6 типов объектов: rect, circle, triangle, line, text, image
 */
(() => {
  // ----------- Получение ID доски ------------
  const params = new URLSearchParams(location.search);
  const boardId = params.get('id');
  if (!boardId) {
    alert('Не указан ID доски');
    location.href = '/';
    return;
  }

  // ----------- DOM-ссылки --------------------
  const $svg = document.getElementById('canvas');
  const $layer = document.getElementById('objects-layer');
  const $wrap = document.getElementById('canvas-wrap');
  const $tools = document.querySelectorAll('.tool');
  const $propsBody = document.getElementById('props-body');
  const $wsStatus = document.getElementById('ws-status');
  const $userCount = document.getElementById('user-count');
  const $boardIdLabel = document.getElementById('board-id');
  const $fileInput = document.getElementById('file-input');
  const $toast = document.getElementById('toast');

  $boardIdLabel.textContent = boardId;

  // ----------- Состояние ---------------------
  /** @type {Map<string, object>} */
  const objects = new Map();
  /** @type {Map<string, SVGElement>} */
  const nodes = new Map();
  let currentTool = 'select';
  let selectedId = null;
  let drag = null; // { id, startX, startY, objStartX, objStartY }
  let ws = null;
  let myUserId = null;

  // ----------- Уведомления -------------------
  let toastTimer = null;
  function toast(text) {
    $toast.textContent = text;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 2000);
  }

  // ----------- WebSocket ---------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.addEventListener('open', () => {
      $wsStatus.className = 'dot dot-on';
      ws.send(JSON.stringify({ type: 'join-board', boardId }));
    });

    ws.addEventListener('close', () => {
      $wsStatus.className = 'dot dot-off';
      toast('Соединение потеряно. Переподключаюсь…');
      setTimeout(connect, 1500);
    });

    ws.addEventListener('error', () => {
      $wsStatus.className = 'dot dot-off';
    });

    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleServerMessage(msg);
    });
  }

  function sendWs(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'board-state':
        myUserId = msg.userId;
        $userCount.textContent = msg.userCount;
        objects.clear();
        $layer.innerHTML = '';
        nodes.clear();
        for (const obj of msg.objects) {
          objects.set(obj.id, obj);
          renderObject(obj);
        }
        break;
      case 'user-joined':
        $userCount.textContent = msg.userCount;
        toast('Присоединился пользователь');
        break;
      case 'user-left':
        $userCount.textContent = msg.userCount;
        toast('Пользователь отключился');
        break;
      case 'create-object':
        if (!objects.has(msg.object.id)) {
          objects.set(msg.object.id, msg.object);
          renderObject(msg.object);
        }
        break;
      case 'update-object':
        objects.set(msg.object.id, msg.object);
        updateNode(msg.object);
        if (msg.object.id === selectedId) renderProps();
        break;
      case 'move-object': {
        const obj = objects.get(msg.id);
        if (!obj) return;
        if (typeof msg.x === 'number') obj.x = msg.x;
        if (typeof msg.y === 'number') obj.y = msg.y;
        if (typeof msg.x2 === 'number') obj.x2 = msg.x2;
        if (typeof msg.y2 === 'number') obj.y2 = msg.y2;
        updateNode(obj);
        if (msg.id === selectedId) renderProps();
        break;
      }
      case 'delete-object':
        removeObject(msg.id);
        break;
      case 'error':
        toast('Ошибка: ' + msg.message);
        break;
    }
  }

  // ----------- Вспомогательные ----------------
  function uuid() {
    return 'o-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  function svgPoint(evt) {
    const rect = $svg.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }

  // ----------- Рендеринг объектов -------------
  function createSvgElement(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  function renderObject(obj) {
    let el;
    switch (obj.type) {
      case 'rect':
        el = createSvgElement('rect');
        break;
      case 'circle':
        el = createSvgElement('circle');
        break;
      case 'triangle':
        el = createSvgElement('polygon');
        break;
      case 'line':
        el = createSvgElement('line');
        break;
      case 'text':
        el = createSvgElement('text');
        break;
      case 'image':
        el = createSvgElement('image');
        break;
      default:
        return;
    }
    el.setAttribute('data-id', obj.id);
    el.classList.add('shape');
    applyAttrs(el, obj);
    attachObjectEvents(el);
    $layer.appendChild(el);
    nodes.set(obj.id, el);
  }

  function updateNode(obj) {
    const el = nodes.get(obj.id);
    if (!el) return;
    applyAttrs(el, obj);
  }

  function applyAttrs(el, obj) {
    switch (obj.type) {
      case 'rect':
        el.setAttribute('x', obj.x);
        el.setAttribute('y', obj.y);
        el.setAttribute('width', obj.width);
        el.setAttribute('height', obj.height);
        el.setAttribute('fill', obj.fill || 'transparent');
        el.setAttribute('stroke', obj.stroke || '#58a6ff');
        el.setAttribute('stroke-width', obj.strokeWidth ?? 2);
        break;
      case 'circle':
        el.setAttribute('cx', obj.x);
        el.setAttribute('cy', obj.y);
        el.setAttribute('r', obj.radius);
        el.setAttribute('fill', obj.fill || 'transparent');
        el.setAttribute('stroke', obj.stroke || '#58a6ff');
        el.setAttribute('stroke-width', obj.strokeWidth ?? 2);
        break;
      case 'triangle': {
        const s = obj.size ?? 80;
        const { x, y } = obj;
        // равносторонний, вершина сверху
        const h = s * Math.sqrt(3) / 2;
        const pts = [
          [x, y],
          [x - s / 2, y + h],
          [x + s / 2, y + h],
        ].map(p => p.join(',')).join(' ');
        el.setAttribute('points', pts);
        el.setAttribute('fill', obj.fill || 'transparent');
        el.setAttribute('stroke', obj.stroke || '#58a6ff');
        el.setAttribute('stroke-width', obj.strokeWidth ?? 2);
        break;
      }
      case 'line':
        el.setAttribute('x1', obj.x);
        el.setAttribute('y1', obj.y);
        el.setAttribute('x2', obj.x2);
        el.setAttribute('y2', obj.y2);
        el.setAttribute('stroke', obj.stroke || '#58a6ff');
        el.setAttribute('stroke-width', obj.strokeWidth ?? 3);
        el.setAttribute('stroke-linecap', 'round');
        break;
      case 'text':
        el.setAttribute('x', obj.x);
        el.setAttribute('y', obj.y);
        el.setAttribute('font-size', obj.fontSize ?? 20);
        el.setAttribute('fill', obj.fill || '#e6edf3');
        el.setAttribute('font-family', 'system-ui, sans-serif');
        el.textContent = obj.text || '';
        break;
      case 'image':
        el.setAttribute('x', obj.x);
        el.setAttribute('y', obj.y);
        el.setAttribute('width', obj.width);
        el.setAttribute('height', obj.height);
        el.setAttribute('href', obj.src);
        el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        break;
    }
    if (obj.id === selectedId) el.classList.add('selected');
    else el.classList.remove('selected');
  }

  function removeObject(id) {
    const el = nodes.get(id);
    if (el) el.remove();
    nodes.delete(id);
    objects.delete(id);
    if (selectedId === id) selectObject(null);
  }

  // ----------- События объектов ---------------
  function attachObjectEvents(el) {
    el.addEventListener('mousedown', (e) => {
      if (currentTool !== 'select') return;
      e.stopPropagation();
      const id = el.getAttribute('data-id');
      selectObject(id);
      const obj = objects.get(id);
      if (!obj) return;
      const p = svgPoint(e);
      drag = {
        id,
        startX: p.x,
        startY: p.y,
        objStartX: obj.x,
        objStartY: obj.y,
        // для линии тащим оба конца
        objStartX2: obj.x2,
        objStartY2: obj.y2,
      };
    });
    el.addEventListener('dblclick', (e) => {
      const id = el.getAttribute('data-id');
      const obj = objects.get(id);
      if (obj && obj.type === 'text') {
        const newText = prompt('Текст:', obj.text || '');
        if (newText !== null) {
          obj.text = newText;
          updateNode(obj);
          sendWs({ type: 'update-object', object: { id, text: newText } });
        }
      }
    });
  }

  // ----------- Выбор ---------------------------
  function selectObject(id) {
    if (selectedId && nodes.has(selectedId)) {
      nodes.get(selectedId).classList.remove('selected');
    }
    selectedId = id;
    if (id && nodes.has(id)) {
      nodes.get(id).classList.add('selected');
    }
    renderProps();
  }

  // ----------- Панель свойств ------------------
  function renderProps() {
    if (!selectedId) {
      $propsBody.innerHTML = '<p class="muted">Выберите объект, чтобы редактировать его свойства.</p>';
      return;
    }
    const obj = objects.get(selectedId);
    if (!obj) {
      $propsBody.innerHTML = '<p class="muted">Объект не найден.</p>';
      return;
    }

    const f = [];
    f.push(`<div class="prop-row"><span class="k">Тип</span><span class="v">${typeLabel(obj.type)}</span></div>`);
    f.push(numField('x', 'X', obj.x));
    f.push(numField('y', 'Y', obj.y));

    if (obj.type === 'rect' || obj.type === 'image') {
      f.push(numField('width', 'Ширина', obj.width));
      f.push(numField('height', 'Высота', obj.height));
    }
    if (obj.type === 'circle') {
      f.push(numField('radius', 'Радиус', obj.radius));
    }
    if (obj.type === 'triangle') {
      f.push(numField('size', 'Размер', obj.size));
    }
    if (obj.type === 'line') {
      f.push(numField('x2', 'X₂', obj.x2));
      f.push(numField('y2', 'Y₂', obj.y2));
    }
    if (obj.type === 'text') {
      f.push(textField('text', 'Текст', obj.text));
      f.push(numField('fontSize', 'Размер шрифта', obj.fontSize));
      f.push(colorField('fill', 'Цвет текста', obj.fill || '#e6edf3'));
    }
    if (['rect', 'circle', 'triangle'].includes(obj.type)) {
      f.push(colorField('fill', 'Заливка', obj.fill || '#00000000'));
      f.push(colorField('stroke', 'Цвет линии', obj.stroke || '#58a6ff'));
      f.push(numField('strokeWidth', 'Толщина', obj.strokeWidth ?? 2));
    }
    if (obj.type === 'line') {
      f.push(colorField('stroke', 'Цвет', obj.stroke || '#58a6ff'));
      f.push(numField('strokeWidth', 'Толщина', obj.strokeWidth ?? 3));
    }

    $propsBody.innerHTML = f.join('');

    // навешиваем обработчики
    $propsBody.querySelectorAll('[data-k]').forEach((input) => {
      input.addEventListener('input', () => {
        const key = input.dataset.k;
        let val = input.value;
        if (input.type === 'number') val = parseFloat(val);
        obj[key] = val;
        updateNode(obj);
        sendWs({ type: 'update-object', object: { id: obj.id, [key]: val } });
      });
    });
  }

  function typeLabel(t) {
    return { rect: 'Прямоугольник', circle: 'Круг', triangle: 'Треугольник',
             line: 'Линия', text: 'Текст', image: 'Изображение' }[t] || t;
  }
  function numField(k, label, v) {
    return `<label class="prop-row"><span class="k">${label}</span><input class="v" type="number" data-k="${k}" value="${v ?? 0}"></label>`;
  }
  function textField(k, label, v) {
    return `<label class="prop-row col"><span class="k">${label}</span><input class="v" type="text" data-k="${k}" value="${(v ?? '').replace(/"/g, '&quot;')}"></label>`;
  }
  function colorField(k, label, v) {
    return `<label class="prop-row"><span class="k">${label}</span><input class="v color" type="color" data-k="${k}" value="${v}"></label>`;
  }

  // ----------- Выбор инструмента ---------------
  $tools.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tool = btn.dataset.tool;
      if (!tool) return;
      $tools.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = tool;
      $svg.style.cursor = tool === 'select' ? 'default' : 'crosshair';

      if (tool === 'image') $fileInput.click();
    });
  });

  document.getElementById('btn-delete').addEventListener('click', deleteSelected);

  function deleteSelected() {
    if (!selectedId) return toast('Ничего не выбрано');
    sendWs({ type: 'delete-object', id: selectedId });
    removeObject(selectedId);
  }

  // ----------- Копирование ID ------------------
  document.getElementById('btn-copy-id').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(boardId);
      toast('ID скопирован');
    } catch {
      toast('Не удалось скопировать');
    }
  });

  // ----------- Создание объектов по клику ------
  $svg.addEventListener('mousedown', (e) => {
    if (e.target !== $svg && e.target.tagName !== 'rect' /* grid bg */) return;
    if (currentTool === 'select') {
      selectObject(null);
      return;
    }
    const p = svgPoint(e);
    const obj = makeDefaultObject(currentTool, p.x, p.y);
    if (!obj) return;
    objects.set(obj.id, obj);
    renderObject(obj);
    sendWs({ type: 'create-object', object: obj });
    selectObject(obj.id);

    // После создания возвращаемся к select для удобного перетаскивания
    $tools.forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
    currentTool = 'select';
    $svg.style.cursor = 'default';
  });

  function makeDefaultObject(tool, x, y) {
    const base = { id: uuid(), type: tool, x, y };
    switch (tool) {
      case 'rect':
        return { ...base, width: 140, height: 90, fill: 'transparent', stroke: '#58a6ff', strokeWidth: 2 };
      case 'circle':
        return { ...base, radius: 50, fill: 'transparent', stroke: '#58a6ff', strokeWidth: 2 };
      case 'triangle':
        return { ...base, size: 100, fill: 'transparent', stroke: '#58a6ff', strokeWidth: 2 };
      case 'line':
        return { ...base, x2: x + 120, y2: y + 80, stroke: '#58a6ff', strokeWidth: 3 };
      case 'text':
        return { ...base, text: 'Двойной клик для редактирования', fontSize: 20, fill: '#e6edf3' };
      default:
        return null;
    }
  }

  // ----------- Загрузка картинок ---------------
  $fileInput.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('Файл слишком большой (>5 МБ)');
      $fileInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      // центрируем примерно в видимой области
      const rect = $svg.getBoundingClientRect();
      const obj = {
        id: uuid(),
        type: 'image',
        x: rect.width / 2 - 100,
        y: rect.height / 2 - 75,
        width: 200,
        height: 150,
        src: reader.result,
      };
      objects.set(obj.id, obj);
      renderObject(obj);
      sendWs({ type: 'create-object', object: obj });
      selectObject(obj.id);
    };
    reader.readAsDataURL(file);
    $fileInput.value = '';
    // возврат к select
    $tools.forEach((b) => b.classList.toggle('active', b.dataset.tool === 'select'));
    currentTool = 'select';
    $svg.style.cursor = 'default';
  });

  // ----------- Перетаскивание ------------------
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const p = svgPoint(e);
    const dx = p.x - drag.startX;
    const dy = p.y - drag.startY;
    const obj = objects.get(drag.id);
    if (!obj) return;
    obj.x = drag.objStartX + dx;
    obj.y = drag.objStartY + dy;
    if (obj.type === 'line' && typeof drag.objStartX2 === 'number') {
      obj.x2 = drag.objStartX2 + dx;
      obj.y2 = drag.objStartY2 + dy;
    }
    updateNode(obj);
  });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    const obj = objects.get(drag.id);
    drag = null;
    if (obj) {
      sendWs({
        type: 'move-object',
        id: obj.id,
        x: obj.x,
        y: obj.y,
        x2: obj.x2,
        y2: obj.y2,
      });
      if (obj.id === selectedId) renderProps();
    }
  });

  // ----------- Горячие клавиши -----------------
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelected();
      return;
    }
    const map = { v:'select', r:'rect', c:'circle', t:'triangle', l:'line', x:'text', i:'image' };
    const tool = map[e.key.toLowerCase()];
    if (tool) {
      const btn = document.querySelector(`.tool[data-tool="${tool}"]`);
      if (btn) btn.click();
    }
  });

  // ----------- Старт ---------------------------
  connect();
})();
