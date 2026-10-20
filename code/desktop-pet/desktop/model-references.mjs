// One tolerant reading of a Cubism `.model3.json` descriptor, shared by the browser
// renderer, the management side and the import tool so their byte bindings cannot drift.
//
// Only `Moc` and `Textures` are required: a Cubism model cannot render without them.
// Physics, Pose, DisplayInfo, UserData, Expressions and Motions are all genuinely optional
// in the format, and a rig that omits them is legitimate, not broken.

/** A reference is accepted only as a plain relative path inside the model directory. */
export function isSafeModelPath(path){
  return typeof path === 'string' && path.length > 0 && path.length <= 512
    && !path.startsWith('/') && !path.startsWith('.')
    && !path.includes('\\') && !path.includes(':') && !path.includes('%')
    && path.split('/').every(part => part && part !== '.' && part !== '..');
}

/**
 * Normalises a parsed descriptor. Throws only when the rig cannot render at all.
 * @param {unknown} manifest parsed `.model3.json`
 */
export function collectModelReferences(manifest){
  const refs = manifest && typeof manifest === 'object' ? /** @type {any} */ (manifest).FileReferences : undefined;
  if(!refs || typeof refs !== 'object') throw Error('This descriptor has no FileReferences.');
  const moc = typeof refs.Moc === 'string' && refs.Moc.trim() ? refs.Moc : '';
  if(!moc) throw Error('This rig has no Moc reference. Only Cubism 3/4 (.model3.json /.moc3) models are supported.');
  const textures = Array.isArray(refs.Textures) ? refs.Textures.filter(name => typeof name === 'string' && name.trim()) : [];
  if(!textures.length) throw Error('This rig references no Textures; a Cubism model cannot render without them.');
  const expressions = Array.isArray(refs.Expressions) ? refs.Expressions.filter(x => x && typeof x.File === 'string' && x.File.trim()) : [];
  /** @type {Record<string, any[]>} */
  const motions = {};
  if(refs.Motions && typeof refs.Motions === 'object' && !Array.isArray(refs.Motions)) {
    for(const [group, list] of Object.entries(refs.Motions)) {
      if(!Array.isArray(list)) continue;
      const usable = list.filter(x => x && typeof x.File === 'string' && x.File.trim());
      if(usable.length) motions[group] = usable;
    }
  }
  const optional = [];
  for(const key of ['Physics', 'Pose', 'DisplayInfo', 'UserData'])
    if(typeof refs[key] === 'string' && refs[key].trim()) optional.push(refs[key]);
  optional.push(...textures, ...expressions.map(x => x.File), ...Object.values(motions).flat().map(x => x.File));
  // The hashed set is exactly what this project has always hashed, so catalogs that were
  // already bound stay valid. Textures and the optional descriptors are read, not hashed.
  const fingerprint = [
    moc,
    typeof refs.Physics === 'string' ? refs.Physics : '',
    ...expressions.map(x => x.File),
    ...Object.values(motions).flat().map(x => x.File),
  ].filter(Boolean);
  return {moc, textures, expressions, motions, required: [moc, ...textures], optional, fingerprint};
}
