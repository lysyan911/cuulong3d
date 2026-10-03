// Shared water, shore and rice cover. North-positive map coordinates, heights in scene metres.
// CPU masks are 20 m, aligned with the satellite group edges; no imagery key is involved.
const clamp = (x,a,b) => Math.min(Math.max(x,a),b);
export const FIELD = { width:84, depth:128, angle:.18, bundWidth:1.4, bundHeight:.45 };

export function fieldPoint(u,v) {
  const c=Math.cos(FIELD.angle),s=Math.sin(FIELD.angle);
  return [u*c-v*s,u*s+v*c];
}
export function fieldCoords(x,y) {
  const c=Math.cos(FIELD.angle),s=Math.sin(FIELD.angle);
  return [x*c+y*s,-x*s+y*c];
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
