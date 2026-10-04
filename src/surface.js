// Shared water, shore and rice cover. North-positive map coordinates, heights in scene metres.
// CPU masks are 20 m, aligned with the satellite group edges; no imagery key is involved.
const clamp = (x,a,b) => Math.min(Math.max(x,a),b);
// Rice field layout, shared with the terrain shader (shaders.js, same formulas): canal blocks of 760 x 1180 m in a
// frame turned by `angle` and gently warped (bunds are not ruler-straight); each block is cut into long strips
// 26-60 m wide, and the strips into 1-3 fields. Field planting stages are chosen in the shader.
export const FIELD = { angle:.18, block:[760,1180], bundHeight:.45, dykeHeight:.8 };
const f32=Math.fround, fr=(x)=>f32(x-Math.floor(x));
/** The terrain shader's hash12, in float32 so both pick the same layouts. */
export function hash12(x,y) {
  let a=fr(f32(x*0.1031)),b=fr(f32(y*0.1031)),c=a;
  const d=f32(f32(f32(a*f32(b+33.33))+f32(b*f32(c+33.33)))+f32(c*f32(a+33.33)));
  a=f32(a+d);b=f32(b+d);c=f32(c+d);
  return fr(f32(f32(a+b)*c));
}
const warpU=(v)=>22*Math.sin(v/410+1.3)+9*Math.sin(v/157), warpV=(u)=>18*Math.sin(u/530+.4)+7*Math.sin(u/190);
/** World (east, north) -> warped field frame. */
export function fieldWarped(x,y) {
  const c=Math.cos(FIELD.angle),s=Math.sin(FIELD.angle),u=x*c+y*s,v=-x*s+y*c;
  return [u+warpU(v),v+warpV(u)];
}
/** Warped field frame -> world (east, north). */
export function fieldWorld(uw,vw) {
  let u=uw,v=vw;
  for(let i=0;i<5;i++){u=uw-warpU(v);v=vw-warpV(u);}
  const c=Math.cos(FIELD.angle),s=Math.sin(FIELD.angle);
  return [u*c-v*s,u*s+v*c];
}
/** Strips and fields of canal block (I, J): cols = strips cut across u; n strips of sw m; parts fields of pl m. */
export function blockLayout(I,J) {
  const [BX,BY]=FIELD.block, h1=hash12(I,J), h2=hash12(I+17,J-5), h3=hash12(I-9,J+31);
  const cols=h1<.5, A=cols?BX:BY, B=cols?BY:BX;
  const n=Math.max(1,Math.floor(A/(26+34*h2)+.5)), parts=1+Math.floor(h3*3);
  return {cols,A,B,n,sw:A/n,parts,pl:B/parts};
}

async function inflate(url) {
  const response=await fetch(url);
  if (!response.ok) throw new Error('Surface data unavailable');
  const stream=response.body.pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

export class SurfaceMap {
  constructor(meta,groups,levels) {
    this.meta=meta;this.groups=groups;this.levels=levels;
    this.res=meta.surface.res_m;this.n=meta.surface.group_px;
    this.span=meta.group*meta.grid_res_m;
    this.left=-meta.width_m/2+meta.grid_res_m/2;
    this.top=meta.height_m/2-meta.grid_res_m/2;
    this.rejectedHouses=0;
  }
  static async load(meta,dataUrl) {
    const groups=[];
    await Promise.all(Array.from({length:meta.groups[1]},(_,gy)=>
      Promise.all(Array.from({length:meta.groups[0]},async(_,gx)=>{
        groups[gy] ||= [];
        const data=new Uint8Array(await inflate(`${dataUrl}surface/s_${gx}_${gy}.bin.z`));
        if(data.length!==meta.surface.group_px**2*3) throw new Error('Invalid surface grid');
        groups[gy][gx]=data;
      }))));
    const levels=new Uint16Array(await inflate(`${dataUrl}surface/water-levels.bin.z`));
    if(levels.length!==meta.rows*meta.cols) throw new Error('Invalid water levels');
    return new SurfaceMap(meta,groups,levels);
  }
  pixel(col,row,channel) {
    const w=this.meta.groups[0]*this.n,h=this.meta.groups[1]*this.n;
    col=clamp(col,0,w-1);row=clamp(row,0,h-1);
    const gx=Math.floor(col/this.n),gy=Math.floor(row/this.n);
    return this.groups[gy][gx][((row%this.n)*this.n+col%this.n)*3+channel];
  }
  sample(x,y,channel) {
    const col=(x-this.left)/this.res-.5,row=(this.top-y)/this.res-.5;
    const j=Math.floor(col),i=Math.floor(row),u=col-j,v=row-i;
    const a=this.pixel(j,i,channel),b=this.pixel(j+1,i,channel),c=this.pixel(j,i+1,channel),d=this.pixel(j+1,i+1,channel);
    return (a*(1-u)+b*u)*(1-v)+(c*(1-u)+d*u)*v;
  }
  waterAt(x,y) { return this.sample(x,y,0)/255; }
  cropAt(x,y) { return this.sample(x,y,1)/255; }
  shoreAt(x,y) { return (this.sample(x,y,2)-128)*2; }
  waterHeight(x,y) {
    const m=this.meta;
    const col=clamp(Math.round((x+m.width_m/2)/m.grid_res_m-.5),0,m.cols-1);
    const row=clamp(Math.round((m.height_m/2-y)/m.grid_res_m-.5),0,m.rows-1);
    return this.levels[row*m.cols+col]/10*m.vert_exag;
  }
  sceneHeight(x,y,raw) {
    const water=this.waterAt(x,y),distance=this.shoreAt(x,y),level=this.waterHeight(x,y);
    if (water>=.5) return level;
    const ex=this.meta.vert_exag;
    // Floodplain land sits above water. A narrow, higher crest gives the riverbank relief.
    const delta=raw<7 ? Math.max(raw,1.05)*ex : raw*ex;
    if(distance>150 || distance<0) return delta;
    const bank=(this.meta.surface.bank_height_m+.28*Math.exp(-distance/22))*ex;
    const fade=1-clamp((distance-60)/90,0,1);
    return Math.max(delta,level+bank*fade);
  }
  allowsHouse(x,y,width,depth,angle,style) {
    const c=Math.cos(angle),s=Math.sin(angle),samples=[];
    for(const [a,b] of [[0,0],[-.44,-.44],[-.44,.44],[.44,-.44],[.44,.44]]) {
      const along=b*depth,across=a*width;
      samples.push(this.waterAt(x+c*along-s*across,y+s*along+c*across));
    }
    const wet=samples.filter(v=>v>=.55).length;
    const stilt=style===4 || style===5;
    // Riverside stilts may overhang a mixed bank; none survive in the open river.
    if(stilt) return wet<5 && this.shoreAt(x,y)>-18;
    return samples[0]<.5 && wet<3;
  }
}
