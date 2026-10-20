import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readVideoPresentation } from './video-presentation.js';
/** Build fixed local routes from the trusted installed manifest. Never resolve a requested path. */
export async function presentationAssetRoutes(projectRoot: string): Promise<ReadonlyMap<string, string>> {
  const desktop = resolve(projectRoot, 'code/desktop-pet/desktop'), base = resolve(desktop, 'assets/local-model');
  let manifest: string;
  try { manifest = await readFile(resolve(base, 'pet.model3.json'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const video = await readVideoPresentation(projectRoot);
    if (video) return video.routes;
    throw error;
  }
  // Every section below Physics is optional in the Cubism format. A rig that omits
  // Expressions or Motions is legitimate, and a rig with a Pose or UserData file needs
  // those routes served too.
  const refs = JSON.parse(manifest)?.FileReferences ?? {};
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
  const expressionFiles = Array.isArray(refs.Expressions) ? (refs.Expressions as { File: string }[]).map(x => x.File) : [];
  const motionFiles = refs.Motions && typeof refs.Motions === 'object' ? Object.values(refs.Motions as Record<string, { File: string }[]>).flat().map(x => x.File) : [];
  const paths: string[] = ['pet.model3.json', 'presets.json',
    ...[refs.Moc, refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData].filter((x): x is string => typeof x === 'string'),
    ...strings(refs.Textures), ...expressionFiles, ...motionFiles];
  const routes = new Map<string, string>();
  for (const path of new Set(paths.filter(Boolean))) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid installed model path');
    routes.set('/presentation-assets/' + path, resolve(base, path));
  }
  const shaderBase = resolve(desktop, 'vendor/cubism/Framework/Shaders/WebGL');
  for (const file of await readdir(shaderBase)) if (/^[a-zA-Z0-9_.-]+\.(frag|vert)$/.test(file)) routes.set('/presentation-shaders/' + file, resolve(shaderBase, file));
  routes.set('/presentation-runtime/core.js', resolve(desktop, 'vendor/cubism/Core/live2dcubismcore.min.js'));
  return routes;
}
