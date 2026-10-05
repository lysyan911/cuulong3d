// Split shoreline triangles into a raised land top, flat water top and exposed bank faces.
// Sharing every edge intersection keeps the mesh watertight within a terrain tile.
export function splitShore(...args) { const g=splitShoreSteps(...args); let r; while(!(r=g.next()).done); return r.value; }
// (Claude Code) the same, in steps: terrain.js spreads the detailed tiles over a few frames
export function* splitShoreSteps(position,normal,uv,index,confidence,surfaceCount,waterHeight,bankHeight) {
  const extraP=[],extraN=[],extraUV=[],surface=[],banks=[],edges=new Map();
  const originalCount=position.length/3;
  const cut=(a,b)=>{
    const key=a<b?`${a}:${b}`:`${b}:${a}`;
    if(edges.has(key))return edges.get(key);
    const t=(.5-confidence[a])/(confidence[b]-confidence[a]);
    const x=position[a*3]+(position[b*3]-position[a*3])*t;
    const z=position[a*3+2]+(position[b*3+2]-position[a*3+2])*t;
    const u=uv[a*2]+(uv[b*2]-uv[a*2])*t,v=uv[a*2+1]+(uv[b*2+1]-uv[a*2+1])*t;
    const wet=originalCount+extraP.length/3,dry=wet+1;
    extraP.push(x,waterHeight(x,-z),z,x,bankHeight(x,-z),z);
    extraN.push(0,1,0,0,1,0);extraUV.push(u,v,u,v);
    const pair=[dry,wet];edges.set(key,pair);return pair;
  };
  const point=(i)=>i<originalCount?position.subarray(i*3,i*3+3):extraP.slice((i-originalCount)*3,(i-originalCount)*3+3);
  const addTri=(out,a,b,c)=>{
    const p=point(a),q=point(b),r=point(c),u=q.map((v,i)=>v-p[i]),v=r.map((v,i)=>v-p[i]);
    const area=Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]);
    if(area>1e-7)out.push(a,b,c);
  };
  const addPolygon=(p)=>{for(let j=1;j<p.length-1;j++)addTri(surface,p[0],p[j],p[j+1]);};
  for(let i=0;i<surfaceCount;i+=3) {
    if(i%12000===0&&i)yield;
    const ids=[index[i],index[i+1],index[i+2]],wet=ids.filter(k=>confidence[k]>=.5).length;
    if(wet===0 || wet===3){surface.push(...ids);continue;}
    const land=[],water=[],crossings=[];
    for(let j=0;j<3;j++){
      const a=ids[j],b=ids[(j+1)%3],aWet=confidence[a]>=.5,bWet=confidence[b]>=.5;
      (aWet?water:land).push(a);
      if(aWet!==bWet){const pair=cut(a,b);land.push(pair[0]);water.push(pair[1]);crossings.push(pair);}
    }
    addPolygon(land);addPolygon(water);
    const [[a,aw],[b,bw]]=crossings;
    addTri(banks,a,aw,b);addTri(banks,b,aw,bw);
  }
  yield;
  const surfaceIndexCount=surface.length+index.length-surfaceCount;
  const indices=surface.concat(index.slice(surfaceCount),banks);
  const append=(original,extra)=>{const a=new Float32Array(original.length+extra.length);a.set(original);a.set(extra,original.length);return a;};
  return {position:append(position,extraP),normal:append(normal,extraN),uv:append(uv,extraUV),indices,surfaceIndexCount,bankIndexCount:banks.length};
}
