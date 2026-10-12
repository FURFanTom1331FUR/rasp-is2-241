// Жесты: свайп влево/вправо, долгое нажатие, «потянуть вниз — обновить», вибро-отклик.
// Слушатели вешаются один раз на контейнер приложения (разметка внутри перерисовывается).

export function haptic(ms = 10) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* не поддерживается */
  }
}

const NO_GESTURE = "input, select, textarea, .sheet, .chip-scroll, .seg-scroll, .update-banner, [data-no-swipe]";

export function attachGestures(root, handlers) {
  let start = null;
  let pressTimer = 0;
  let pressed = false;
  let pulling = false;
  const indicator = document.createElement("div");
  indicator.className = "ptr";
  indicator.setAttribute("aria-hidden", "true");
  indicator.innerHTML = `<span class="ptr-dot">↓</span><span class="ptr-text">Потяните, чтобы обновить</span>`;
  document.body.appendChild(indicator);

  function clearPress() {
    clearTimeout(pressTimer);
    pressTimer = 0;
  }

  function setPull(distance) {
    const shown = Math.min(distance, 110);
    indicator.style.setProperty("--pull", `${shown}px`);
    indicator.classList.toggle("visible", shown > 8);
    const ready = distance > 80;
    indicator.classList.toggle("ready", ready);
    indicator.querySelector(".ptr-text").textContent = ready ? "Отпустите — обновим" : "Потяните, чтобы обновить";
  }

  root.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        start = null;
        clearPress();
        return;
      }
      const touch = event.touches[0];
      const blocked = Boolean(event.target.closest?.(NO_GESTURE));
      start = { x: touch.clientX, y: touch.clientY, t: Date.now(), blocked, top: window.scrollY <= 0, target: event.target };
      pressed = false;
      pulling = false;
      const card = event.target.closest?.("[data-press]");
      if (card && !blocked && handlers.onLongPress) {
        pressTimer = setTimeout(() => {
          pressed = true;
          haptic(15);
          handlers.onLongPress(card);
        }, 520);
      }
    },
    { passive: true },
  );

  root.addEventListener(
    "touchmove",
    (event) => {
      if (!start) return;
      const touch = event.touches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearPress();
      if (!start.blocked && start.top && dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.5 && handlers.onRefresh && window.scrollY <= 0) {
        pulling = true;
        setPull(dy * 0.6);
      }
    },
    { passive: true },
  );

  root.addEventListener(
    "touchend",
    (event) => {
      clearPress();
      if (!start) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      const dt = Date.now() - start.t;
      const info = start;
      start = null;
      if (pulling) {
        const ready = dy * 0.6 > 80;
        pulling = false;
        if (ready) {
          haptic(10);
          indicator.classList.add("busy");
          indicator.style.setProperty("--pull", "64px");
          indicator.querySelector(".ptr-text").textContent = "Обновляем…";
          handlers.onRefresh();
          setTimeout(() => {
            indicator.classList.remove("busy");
            setPull(0);
          }, 900);
        } else setPull(0);
        return;
      }
      if (pressed) {
        // Гасим только «клик», который браузер может прислать сразу после долгого нажатия.
        setTimeout(() => {
          pressed = false;
        }, 400);
        return;
      }
      if (info.blocked) return;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 60 && Math.abs(dx) > Math.abs(dy) * 1.8 && dt < 700) {
        const direction = dx < 0 ? "left" : "right";
        if (handlers.onSwipe?.(direction)) haptic(8);
      }
    },
    { passive: true },
  );

  root.addEventListener("touchcancel", () => {
    clearPress();
    start = null;
    if (pulling) setPull(0);
    pulling = false;
  });

  // Долгое нажатие мышью / контекстное меню (компьютер, некоторые Android).
  root.addEventListener("contextmenu", (event) => {
    const card = event.target.closest?.("[data-press]");
    if (!card || !handlers.onLongPress || event.target.closest("a")) return;
    event.preventDefault();
    if (!pressed) handlers.onLongPress(card);
  });

  // После долгого нажатия не открывать ссылку/кнопку под пальцем.
  root.addEventListener(
    "click",
    (event) => {
      if (pressed) {
        event.preventDefault();
        event.stopPropagation();
        pressed = false;
      }
    },
    true,
  );
}
