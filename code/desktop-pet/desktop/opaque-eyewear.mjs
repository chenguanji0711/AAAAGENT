// Optional model-specific appearance adapter. Cubism continues to own every vertex
// and deformation; only the existing eyewear's texture coordinates and covered-eye
// visibility change. Never infer screen positions from neighboring atlas islands.
const coveredEyes = /^ArtMesh(?:Irides|Eyewhite|Eyelash)[LR]$/;
export function bindOpaqueEyewear(drawables, profile, textureCount) {
  if (profile == null) return null;
  const index = drawables.ids.indexOf(profile.drawable);
  const rect = profile.uvRect ?? [0,0,1,1];
  if (profile.drawable !== 'ArtMeshEyewear' || index < 0 ||
      !Number.isInteger(profile.texture) || profile.texture < 1 || profile.texture >= textureCount ||
      !Array.isArray(profile.hide) || !profile.hide.length ||
      profile.hide.some(id => !coveredEyes.test(id) || !drawables.ids.includes(id)) ||
      !Array.isArray(rect) || rect.length !== 4 || rect.some(n => !Number.isFinite(n) || n < 0 || n > 1) ||
      rect[0] >= rect[2] || rect[1] >= rect[3]) throw Error('眼罩外观配置与模型不匹配');
  const uv = drawables.vertexUvs[index];
  const xs = Array.from(uv).filter((_,i) => i%2===0), ys=Array.from(uv).filter((_,i) => i%2===1);
  const x0=Math.min(...xs), x1=Math.max(...xs), y0=Math.min(...ys), y1=Math.max(...ys);
  if (![x0,x1,y0,y1].every(Number.isFinite) || x1<=x0 || y1<=y0) throw Error('眼罩网格缺少有效 UV');
  const hidden=profile.hide.map(id=>drawables.ids.indexOf(id));
  for(let i=0;i<uv.length;i+=2){
    uv[i]=rect[0]+(uv[i]-x0)/(x1-x0)*(rect[2]-rect[0]);
    uv[i+1]=rect[1]+(uv[i+1]-y0)/(y1-y0)*(rect[3]-rect[1]);
  }
  drawables.textureIndices[index]=profile.texture;
  return {apply(){ for(const i of hidden) drawables.opacities[i]=0; }, drawable:profile.drawable, texture:profile.texture};
}
