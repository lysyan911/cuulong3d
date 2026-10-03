// Trà Sư footprint and canopy from cached data. Local x=east, z=south; scene heights in metres.
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
export const hash=(x,z,k=0)=>{let n=Math.imul(x,374761393)^Math.imul(z,668265263)^Math.imul(k,144269);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967296;};

export function nearestPath(x,z,paths) {
  let best={distance:Infinity,x:0,z:0,width:0};
  for(const path of paths) for(let i=1;i<path.points.length;i++) {
    const a=path.points[i-1],b=path.points[i],dx=b[0]-a[0],dz=b[1]-a[1];
    const t=clamp(((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz||1),0,1);
    const px=a[0]+dx*t,pz=a[1]+dz*t,d=Math.hypot(x-px,z-pz);
    if(d<best.distance)best={distance:d,x:px,z:pz,width:path.width};
  }
  return best;
}
export function pathPoint(points,t) {
  t=clamp(t,0,.999999)*(points.length-1);
  const i=Math.floor(t),f=t-i,a=points[i],b=points[i+1];
  return {x:a[0]+(b[0]-a[0])*f,z:a[1]+(b[1]-a[1])*f,angle:Math.atan2(b[0]-a[0],b[1]-a[1])};
}

export class WetlandMap {
  constructor(data,pixels,ex=3) {this.data=data;this.pixels=pixels;this.centre=data.centre;this.level=data.water_m*ex;this.ex=ex;}
  static async load(url,ex) {
    const r=await fetch(url+'trasu.json');
    if(!r.ok)return null;
    const data=await r.json(),response=await fetch(url+'trasu-cover.bin.z');
    if(!response.ok)throw new Error('Trà Sư cover unavailable');
    const pixels=new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    if(pixels.length!==data.cols*data.rows*3)throw new Error('Invalid Trà Sư cover');
    return new WetlandMap(data,pixels,ex);
  }
  local(x,north) {return [x-this.centre[0],-north-this.centre[1]];}
  sampleLocal(x,z,channel=0) {
    const d=this.data,[l,t,r,b]=d.bounds;
    if(x<l||x>r||z<t||z>b)return 0;
    const c=(x-l)/d.res-.5,row=(z-t)/d.res-.5,j=Math.floor(c),i=Math.floor(row),u=c-j,v=row-i;
    const p=(xx,zz)=>this.pixels[(clamp(zz,0,d.rows-1)*d.cols+clamp(xx,0,d.cols-1))*3+channel]/255;
    return (p(j,i)*(1-u)+p(j+1,i)*u)*(1-v)+(p(j,i+1)*(1-u)+p(j+1,i+1)*u)*v;
  }
  floodAt(x,north) {const [a,b]=this.local(x,north);return this.sampleLocal(a,b);}
  sceneHeight(x,north,previous) {const f=this.floodAt(x,north);return previous*(1-f)+(this.level-.24)*f;}
  generateTrees(spacing=11) {
    const trees=[],[l,t,r,b]=this.data.bounds;
    for(let z=Math.floor(t/spacing);z*spacing<b;z++) for(let x=Math.floor(l/spacing);x*spacing<r;x++) {
      const px=(x+.05+.9*hash(x,z,1))*spacing,pz=(z+.05+.9*hash(x,z,2))*spacing;
      if(this.sampleLocal(px,pz)<.98 || this.sampleLocal(px,pz,1)<.38 || hash(x,z,3)>.93)continue;
      const path=nearestPath(px,pz,this.data.channels);
      if(path.distance<path.width*.5+3)continue;
      const arch=path.distance<path.width*.5+25;
      trees.push({x:px,z:pz,scale:.78+hash(x,z,4)*.5,phase:hash(x,z,5),tint:.82+hash(x,z,6)*.3,
                  variant:arch?1:hash(x,z,7)>.72?2:0,angle:arch?Math.atan2(-(path.z-pz),path.x-px):hash(x,z,8)*Math.PI*2});
    }
    return trees;
  }
}
