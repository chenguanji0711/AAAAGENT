// Keep the working renderer alive until the replacement has loaded all assets.
export async function loadRendererReplacement(current, next) {
  try { await next.load(); }
  catch (error) { next.dispose(); throw error; }
  current?.dispose();
  return next;
}
