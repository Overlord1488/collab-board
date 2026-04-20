// Главная страница — создание доски или подключение по ID
(() => {
  const $status = document.getElementById('status');
  const $input = document.getElementById('board-id-input');

  function setStatus(text, isError = false) {
    $status.textContent = text;
    $status.className = 'status' + (isError ? ' error' : '');
  }

  document.getElementById('btn-create').addEventListener('click', async () => {
    setStatus('Создаю доску…');
    try {
      const res = await fetch('/board', { method: 'POST' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      window.location.href = `/board.html?id=${encodeURIComponent(data.id)}`;
    } catch (e) {
      setStatus('Ошибка создания доски: ' + e.message, true);
    }
  });

  document.getElementById('btn-join').addEventListener('click', () => {
    const id = $input.value.trim();
    if (!id) return setStatus('Введите ID доски', true);
    window.location.href = `/board.html?id=${encodeURIComponent(id)}`;
  });

  $input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });
})();
