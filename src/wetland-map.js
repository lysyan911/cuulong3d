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
    const trees=[],[l,t,r,b]=this.data.bounds,bins=new Map(),step=28;
    const occupied=(x,z,gap)=>{
      for(let j=Math.floor(z/4)-1;j<=Math.floor(z/4)+1;j++)for(let i=Math.floor(x/4)-1;i<=Math.floor(x/4)+1;i++)
        for(const p of bins.get(`${i},${j}`)||[])if(Math.hypot(p.x-x,p.z-z)<Math.max(gap,p.gap))return true;
      return false;
    };
    const boardwalk=[{points:this.data.boardwalk,width:2.2}];
    // Random parent groves, offspring at radial offsets, and variable spacing. No tree lattice.
    for(let z=Math.floor(t/step)-1;z*step<b+step;z++)for(let x=Math.floor(l/step)-1;x*step<r+step;x++) {
      const cx=(x+hash(x,z,31))*step,cz=(z+hash(x,z,32))*step;
      const patch=hash(Math.floor(cx/85),Math.floor(cz/85),17);
      const n=Math.round((12+hash(x,z,33)*22)*(patch<.12?.28:1)*(11/spacing)**2);
      for(let k=0;k<n;k++) {
        const a=hash(x,z,40+k*7)*Math.PI*2,rad=Math.sqrt(hash(x,z,41+k*7))*23;
        const px=cx+Math.cos(a)*rad,pz=cz+Math.sin(a)*rad;
        if(this.sampleLocal(px,pz)<.98 || this.sampleLocal(px,pz,1)<.34)continue;
        const path=nearestPath(px,pz,this.data.channels),edge=path.distance-path.width*.5;
        if(edge<1.8 || nearestPath(px,pz,boardwalk).distance<2.2)continue;
        const riparian=edge<24;
        if(!riparian && hash(x,z,42+k*7)>.76)continue;
        const young=hash(x,z,43+k*7)<.25,gap=young?2.35:3.5;
        if(occupied(px,pz,gap))continue;
        const form=young?0:riparian?(hash(x,z,44+k*7)<.55?3:2):1+Math.floor(hash(x,z,44+k*7)*5);
        const p={x:px,z:pz,gap,form,variant:riparian?1:0,scale:.82+hash(x,z,45+k*7)*.36,
          phase:hash(x,z,46+k*7),tint:.86+hash(x,z,47+k*7)*.25,edge,
          angle:riparian?Math.atan2(-(path.z-pz),path.x-px)+(hash(x,z,48+k*7)-.5)*.45:hash(x,z,48+k*7)*Math.PI*2};
        const key=`${Math.floor(px/4)},${Math.floor(pz/4)}`;if(!bins.has(key))bins.set(key,[]);bins.get(key).push(p);trees.push(p);
      }
    }
    return trees;
  }
}
