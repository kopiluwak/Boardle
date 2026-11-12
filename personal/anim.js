// Tiny board animation helper shared by the puzzle board (app.js) and the Openings panel.
// Call right after a board render: slides the piece now on `to` from the `from` square.

export const REPLY_DELAY_MS = 500; // pause before the computer plays its reply
export const SLIDE_MS = 260;

export function slidePiece(boardEl, from, to, ms = SLIDE_MS) {
  if (!boardEl || !from || !to || typeof requestAnimationFrame !== "function") return;
  const a = boardEl.querySelector(`[data-sq="${from}"]`);
  const b = boardEl.querySelector(`[data-sq="${to}"]`);
  const img = b && b.querySelector("img");
  if (!a || !img || !a.getBoundingClientRect) return;
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  // squares clip their content; let the moving piece fly over its neighbours for the slide
  b.style.overflow = "visible";
  b.style.zIndex = "10";
  img.style.position = "relative";
  img.style.transition = "none";
  img.style.transform = `translate(${ra.left - rb.left}px, ${ra.top - rb.top}px)`;
  img.getBoundingClientRect(); // flush so the start offset applies before the transition
  requestAnimationFrame(() => {
    img.style.transition = `transform ${ms}ms ease-out`;
    img.style.transform = "";
  });
  setTimeout(() => { b.style.overflow = ""; b.style.zIndex = ""; }, ms + 60);
}
