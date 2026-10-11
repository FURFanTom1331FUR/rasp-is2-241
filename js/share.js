// Картинка с расписанием (canvas) для «Поделиться»: в стиле приложения, работает офлайн.

const W = 1080;
const PAD = 56;
const COLORS = {
  bg: "#f4f0e8",
  card: "#fffdf8",
  ink: "#1c1915",
  muted: "#6e675d",
  line: "#e6dfd2",
  accent: "#2f6d4f",
  accentSoft: "#e5f3ea",
  лек: "#2f6d4f",
  лаб: "#1d5f86",
  пр: "#8d4e16",
  none: "#6e675d",
};
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function font(size, weight = 600) {
  return `${weight} ${size}px ${FONT}`;
}

function wrap(ctx, text, maxWidth, maxLines = 3) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word;
    if (ctx.measureText(probe).width <= maxWidth || !line) line = probe;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// model: { kicker, title, subtitle, days: [{ label, lessons: [{ start, end, type, subject, meta }] | null }], footer }
// lessons === null — для дня нет сохранённых данных.
function layout(ctx, model, draw) {
  let y = PAD;
  const inner = W - PAD * 2;
  ctx.textBaseline = "top";
  ctx.font = font(30, 800);
  if (draw) {
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(String(model.kicker || "").toUpperCase(), PAD, y);
  }
  y += 46;
  ctx.font = font(64, 800);
  for (const line of wrap(ctx, model.title, inner, 2)) {
    if (draw) {
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(line, PAD, y);
    }
    y += 74;
  }
  ctx.font = font(34, 600);
  if (draw) {
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(model.subtitle || "", PAD, y);
  }
  y += 70;
  for (const day of model.days) {
    ctx.font = font(34, 800);
    if (draw) {
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(day.label, PAD, y);
    }
    y += 52;
    const lessons = day.lessons;
    if (!lessons || !lessons.length) {
      const h = 84;
      if (draw) {
        ctx.fillStyle = COLORS.card;
        roundRect(ctx, PAD, y, inner, h, 26);
        ctx.fill();
        ctx.fillStyle = COLORS.muted;
        ctx.font = font(32, 650);
        ctx.fillText(lessons ? "Нет пар" : "Нет сохранённого расписания", PAD + 34, y + 26);
      }
      y += h + 26;
      continue;
    }
    for (const lesson of lessons) {
      const textX = PAD + 34;
      const textW = inner - 34 - 30;
      ctx.font = font(36, 800);
      const subject = wrap(ctx, lesson.subject, textW, 2);
      ctx.font = font(28, 600);
      const meta = lesson.meta ? wrap(ctx, lesson.meta, textW, 2) : [];
      const h = 26 + 44 + subject.length * 44 + meta.length * 36 + 24;
      if (draw) {
        ctx.fillStyle = COLORS.card;
        roundRect(ctx, PAD, y, inner, h, 26);
        ctx.fill();
        ctx.fillStyle = COLORS[lesson.type] || COLORS.none;
        roundRect(ctx, PAD, y + 18, 8, h - 36, 4);
        ctx.fill();
        ctx.font = font(36, 800);
        ctx.fillStyle = COLORS.ink;
        ctx.fillText(`${lesson.start}–${lesson.end}`, textX, y + 24);
        if (lesson.type || lesson.badge) {
          const chip = [lesson.type, lesson.badge].filter(Boolean).join(" · ");
          ctx.font = font(26, 800);
          const cw = ctx.measureText(chip).width + 32;
          ctx.fillStyle = COLORS.accentSoft;
          roundRect(ctx, PAD + inner - 30 - cw, y + 22, cw, 42, 21);
          ctx.fill();
          ctx.fillStyle = COLORS[lesson.type] || COLORS.muted;
          ctx.fillText(chip, PAD + inner - 30 - cw + 16, y + 30);
        }
        let ty = y + 24 + 50;
        ctx.font = font(36, 800);
        ctx.fillStyle = COLORS.ink;
        for (const line of subject) {
          ctx.fillText(line, textX, ty);
          ty += 44;
        }
        ctx.font = font(28, 600);
        ctx.fillStyle = COLORS.muted;
        for (const line of meta) {
          ctx.fillText(line, textX, ty + 2);
          ty += 36;
        }
      }
      y += h + 18;
    }
    y += 16;
  }
  y += 10;
  if (draw) {
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y);
    ctx.lineTo(W - PAD, y);
    ctx.stroke();
    ctx.font = font(28, 700);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(model.footer || "", PAD, y + 24);
    ctx.font = font(24, 600);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(model.stamp || "", PAD, y + 64);
  }
  return y + 64 + 34 + PAD;
}

export function drawShareImage(model, doc = document) {
  const canvas = doc.createElement("canvas");
  canvas.width = W;
  canvas.height = 400;
  const height = Math.min(layout(canvas.getContext("2d"), model, false), 8000);
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, height);
  layout(ctx, model, true);
  return canvas;
}

export function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no blob"))), "image/png");
  });
}

export function shareFileName(title, range) {
  const safe = `${title}-${range}`.replace(/[^0-9A-Za-zА-Яа-яЁё.-]+/g, "_").replace(/_+/g, "_");
  return `pary-${safe}.png`;
}
