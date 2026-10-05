// Original close-up geometry. Shared photo atlas / aPart convention supplied by trees.js.
// These models are only selected within 150 m; the existing outer LODs stay cheap.
export const CLOSE_TREE_RADIUS = 150;
export const CLOSE_TREE_FULL_RADIUS = 70;
export const CLOSE_TREE_REFRESH_MARGIN = 8;
export const CLOSE_TREE_EXTRA_FRACTION = 0.25;

export function closeTreeModels(Model, cells, uvRect, bark) {
  const white = uvRect(cells.white), leafUV = name => uvRect(cells[name]);
  const normal = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const add = (a, b) => a.map((v, i) => v + b[i]);
  const mul = (a, k) => a.map(v => v * k);
  const tint = (a, k) => a.map(v => v * k);

  // Connected tapered rings, including leaning/forked limbs. Bark stays rigid (aPart=0).
  function limb(m, points, radii, colour, sides = 5, part = 0, cell = 'white') {
    const rect = cell === 'white' ? white : leafUV(cell);
    const rows = points.map((p, k) => {
      const a = points[Math.max(0, k-1)], b = points[Math.min(points.length-1, k+1)];
      const axis = normal(b.map((v, i) => v-a[i]));
      const u = normal(cross(axis, Math.abs(axis[1]) > .9 ? [1, 0, 0] : [0, 1, 0]));
      const v = cross(axis, u);
      return Array.from({length: sides+1}, (_, j) => {
        const angle = j/sides*Math.PI*2, n = add(mul(u, Math.cos(angle)), mul(v, Math.sin(angle)));
        const uv = cell === 'white' ? [rect[0]+rect[2]*.5, rect[1]+rect[3]*.5]
          : [rect[0]+rect[2]*j/sides, rect[1]+rect[3]*k/(points.length-1)];
        return m.vert(add(p, mul(n, radii[k])), n, uv,
          part, tint(colour, 1 + .09*Math.cos(angle*3+k)));
      });
    });
    for (let k=0; k<rows.length-1; k++) for (let j=0; j<sides; j++) {
      const a=rows[k][j], b=rows[k][j+1], c=rows[k+1][j+1], d=rows[k+1][j];
      m.idx.push(a,b,c,a,c,d);
    }
  }

  // Three oblique, offset cards per twig: crown gaps expose limbs instead of a single crown billboard.
  function cluster(m, p, w, h, az, colour) {
    for (let j=0; j<3; j++) {
      const a=az+j*1.05, u=[Math.cos(a), .15*Math.sin(a*2), Math.sin(a)];
      const v=j===2 ? normal([.3*Math.cos(a), .75, -.55]) : [0, 1, 0];
      const centre=add(p, [.12*Math.sin(a), j*.10, .13*Math.cos(a)]);
      const corners=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) =>
        add(centre, add(mul(u, x*w*.5), mul(v, y*h*.5))));
      m.quadP(corners, leafUV('mangoTwig'), q =>
        normal([q[0]*.45, .7+(q[1]-4)*.18, q[2]*.45]), 1, tint(colour, .88+j*.08));
    }
  }

  // Folded long leaf/frond. A narrow raised midrib and taper give volume from both street and aerial views.
  function blade(m, base, az, elev, length, width, droop, cell, colour, segments=5, torn=false) {
    const [u0,v0,du,dv]=leafUV(cell), hx=Math.cos(az), hz=Math.sin(az), px=-hz, pz=hx;
    const rows=[];
    // The photographed banana donor starts inside its rectangle; carry the petiole into that visible leaf.
    if (cell === 'banana') {
      const t=.23;
      limb(m,[base,[base[0]+hx*length*t*Math.cos(elev),base[1]+length*t*Math.sin(elev)-droop*length*t*t,
        base[2]+hz*length*t*Math.cos(elev)]],[.016,.010],tint(colour,.68),3,1);
    }
    for (let k=0; k<=segments; k++) {
      const t=k/segments, envelope=Math.pow(Math.sin(Math.PI*t), .65);
      const w=width*.5*(.07+.93*envelope), fold=.035*length*envelope;
      const c=[base[0]+hx*length*t*Math.cos(elev), base[1]+length*t*Math.sin(elev)-droop*length*t*t,
        base[2]+hz*length*t*Math.cos(elev)];
      const n=normal([hx*.3, 1, hz*.3]), row=[];
      for (let j=-1; j<=1; j++) {
        const edge=torn && j!==0 && k>1 && k<segments ? (k%3===0 ? .73 : 1) : 1;
        row.push(m.vert([c[0]+px*w*j*edge, c[1]+(j===0 ? fold : 0), c[2]+pz*w*j*edge],
          n, [u0+du*t, v0+dv*(j+1)*.5], 1, tint(colour, j===0 ? 1.06 : .94)));
      }
      rows.push(row);
    }
    for (let k=0; k<segments; k++) for (let j=0; j<2; j++) {
      const a=rows[k][j], b=rows[k][j+1], c=rows[k+1][j+1], d=rows[k+1][j];
      // Small slots on alternate outside strips augment the atlas tears, without cutting the midrib.
      if (torn && k>0 && k<segments-1 && (k+j)%3===0) m.idx.push(a,b,d);
      else m.idx.push(a,b,c,a,c,d);
    }
  }

  const mango=new Model();
  const wood=[.82,.79,.72];
  const mangoLimb = (points, radii, sides) => limb(mango,points,radii,wood,sides,0,'mangoBark');
  mangoLimb([[0,0,0],[.08,.8,-.04],[-.10,1.8,.1],[.12,2.75,0]], [.32,.25,.22,.17], 7);
  // Root flares and low crotches are visible below the dense, broad dome.
  for (let i=0; i<4; i++) {
    const a=i*1.57+.3;
    mangoLimb([[Math.cos(a)*.48,.04,Math.sin(a)*.48],[.03,.70,0]], [.08,.19], 4);
  }
  for (let i=0; i<6; i++) {
    const az=i*2.399+.3, reach=2.15+(i%3)*.35, y=4.45+(i%3)*.35;
    const tip=[Math.cos(az)*reach,y,Math.sin(az)*reach];
    const fork=[Math.cos(az)*.7,3.45+(i%2)*.35,Math.sin(az)*.7];
    mangoLimb([[.08,2.15+(i%3)*.20,0],fork,tip], [.16,.105,.038], 5);
    for (let j=0; j<3; j++) {
      const a=az+(j-1)*.56, r=reach+(j===1 ? .25 : -.35);
      const end=[Math.cos(a)*r,y+.7+j*.22,Math.sin(a)*r];
      mangoLimb([tip,end], [.032,.012], 4);
      cluster(mango, end, 2.55-(j%2)*.2, 1.65, a, [.66,.79,.59]);
    }
  }
  for (let i=0; i<5; i++) {
    const a=i*2.399, p=[Math.cos(a)*1.25,7.0+(i%2)*.23,Math.sin(a)*1.25];
    mangoLimb([[0,3.6,0],p], [.085,.018], 4);
    cluster(mango, p, 2.6, 1.5, a, [.75,.87,.64]);
  }

  const coconut=new Model(), trunk=[];
  for (let i=0; i<=8; i++) {
    const t=i/8; trunk.push([1.15*t*t,10.55*t,.24*Math.sin(t*2)]);
  }
  limb(coconut, trunk, trunk.map((_,i) => .25-i*.014), [.90,.86,.81], 7,0,'coconutBark');
  const head=trunk.at(-1);
  // 26 live fronds: ascending new spears, broad middle crown, old drooping lower ring.
  for (let i=0; i<26; i++) {
    const ring=i%3, az=i*2.399, elev=[1.02,.44,.03][ring]+.06*Math.sin(i*4);
    blade(coconut, add(head,[0,-ring*.13,0]), az,elev,4.6+(i%4)*.18,1.15+(i%3)*.07,
      [.26,.36,.53][ring],'frond',[.84+.05*ring,.95,.76-.06*ring],4);
  }
  for (let i=0; i<2; i++) blade(coconut,add(head,[0,-.4,0]),i*2.7,-.45,3.8,.9,.5,'frond',[.72,.55,.27],3);
  // Short green leaf bases around the crownshaft (not another round crown).
  for (let i=0; i<5; i++) {
    const a=i*1.257;
    limb(coconut,[add(head,[0,-.5,0]),add(head,[Math.cos(a)*.33,.1,Math.sin(a)*.33])], [.12,.04], [.32,.38,.14],4);
  }

  const banana=new Model();
  // Four full-sized plants share a rhizome mat; two small sword suckers fill its edges.
  const stems=[[.05,.05,3.6,1],[-.75,.46,3.25,.95],[.71,.69,3.1,.90],[.49,-.67,2.8,.86]];
  stems.forEach(([x,z,h,size],j) => {
    limb(banana,[[x,0,z],[x+.04,h*.35,z],[x+.09,h*.70,z+.03],[x+.13,h,z+.07]],
      [.125*size,.115*size,.100*size,.077*size],[1,1,1],6,0,'bananaStem');
    // Thin loose sheaths curl away from the green stem at the base, rather than extra branches.
    for (let i=0;i<2;i++) {
      const az=j*1.5+i*2.4, dx=Math.cos(az), dz=Math.sin(az);
      const corners=[[x+dx*.12,.95,z+dz*.12],[x+dx*.12+.09,.91,z+dz*.12],
        [x+dx*.34+.08,.11,z+dz*.34],[x+dx*.34,.15,z+dz*.34]];
      banana.quadP(corners,white,()=>normal([dx,.15,dz]),0,[.27,.17,.065]);
    }
    for (let i=0;i<7;i++) {
      const a=i*2.399+j*1.35, elevation=[.65,.36,.10][i%3], L=(2.13+(i%3)*.14)*size;
      const base=[x+.13,h-.08-(i%3)*.12,z+.07];
      const stalk=[base[0]+Math.cos(a)*.37,base[1]+.22,base[2]+Math.sin(a)*.37];
      limb(banana,[base,stalk],[.025,.015],[.26,.43,.09],3,1);
      blade(banana,stalk,a,elevation,L,.59*size,.48,'bananaBlade',[.97,1.07,.75],4,true);
    }
    // Dry leaves wrap downwards under each mature crown.
    blade(banana,[x+.13,h-.38,z+.07],j*2.4,-.67,1.70,.40,.30,'bananaBlade',[.54,.32,.095],3,true);
    limb(banana,[[x+.13,h-.04,z+.07],[x+.17,h+.73,z+.09],[x+.28,h+1.28,z+.12]],
      [.049,.027,.002],[.42,.64,.16],4,1);
  });
  for (let j=0;j<2;j++) {
    const x=j===0?-1.04:.89,z=j===0?-.55:-.90,h=j===0?1.28:.80;
    limb(banana,[[x,0,z],[x+.03,h,z+.02]],[.075,.040],[.60,.72,.23],5,0,'bananaStem');
    for(let i=0;i<3;i++) blade(banana,[x,h-.04,z],i*2.1+j,.93,1.10,.28,.32,'bananaBlade',[.93,1.05,.67],3,true);
    limb(banana,[[x,h-.07,z],[x+.08,h+.61,z+.05]],[.035,.003],[.46,.64,.19],3,1);
  }
  return { fruit:mango.geometry(), coconut:coconut.geometry(), banana:banana.geometry() };
}

// Economical outer versions keep clustered crowns / banana mats when crossing the detail boundary.
export function outerCloseTreeModels(Model, cells, uvRect, bark) {
  const white=uvRect(cells.white), normal=v=>{const l=Math.hypot(...v)||1;return v.map(x=>x/l);};
  const card=(m,p,w,h,a,cell,col,part=1)=>{
    const dx=Math.cos(a)*w/2,dz=Math.sin(a)*w/2;
    m.quadP([[p[0]-dx,p[1]-h/2,p[2]-dz],[p[0]+dx,p[1]-h/2,p[2]+dz],
      [p[0]+dx,p[1]+h/2,p[2]+dz],[p[0]-dx,p[1]+h/2,p[2]-dz]],uvRect(cells[cell]),
      ()=>normal([Math.sin(a)*.4,.8,-Math.cos(a)*.4]),part,col);
  };
  const mango=new Model();mango.trunk(3.35,.28,.17,[.15,.12,.065],{rings:1,segs:3});
  for(let i=0;i<3;i++) {
    const a=i*2.1, tip=[Math.cos(a)*1.5,5.65,Math.sin(a)*1.5];
    const side=[Math.sin(a)*.12,0,-Math.cos(a)*.12];
    mango.quadP([[side[0],2.5,side[2]],[-side[0],2.5,-side[2]],
      [tip[0]-side[0]*.3,tip[1],tip[2]-side[2]*.3],[tip[0]+side[0]*.3,tip[1],tip[2]+side[2]*.3]],
      white,()=>[0,1,0],0,[.16,.12,.075]);
  }
  for(let i=0;i<8;i++) {
    const a=i*2.399,r=i<5?2.0:1.1,y=i<5?5.85+(i%2)*.35:7.18;
    card(mango,[Math.cos(a)*r,y,Math.sin(a)*r],2.75,2.05,a+.6,'mangoTwig',[.72,.83,.61]);
  }
  const coconut=new Model();coconut.trunk(10.55,.25,.14,[.28,.23,.16],{rings:2,segs:4,bend:1.15});
  for(let i=0;i<26;i++) {
    const ring=i%3, elev=[1.02,.44,.03][ring];
    coconut.frond([1.15,10.55-ring*.13,.22],i*2.399,elev,4.6+(i%4)*.18,1.2,
      [.26,.36,.53][ring],'frond',[.84+.05*ring,.95,.76-.06*ring],ring===0?1:2);
  }
  for(let i=0;i<2;i++) coconut.frond([1.15,10.15,.22],i*2.7,-.45,3.8,.9,.5,'frond',[.72,.55,.27],1);
  const banana=new Model();
  for(let j=0;j<4;j++) {
    const x=[.05,-.75,.71,.49][j],z=[.05,.46,.69,-.67][j],h=[3.6,3.25,3.1,2.8][j];
    // Crossed stem ribbons, then broad alpha blades; at this range the grouped silhouette matters most.
    card(banana,[x,h/2,z],.24,h,0,'bananaStem',[.75,.95,.7],0);
    card(banana,[x,h/2,z],.24,h,1.57,'bananaStem',[.75,.95,.7],0);
    for(let i=0;i<4;i++) banana.frond([x,h-.1,z],i*2.399+j, .62-(i%3)*.28,
      2.26-j*.08,.59,.48,'bananaBlade',[.97,1.07,.75],1);
    card(banana,[x+.1,h+.48,z],.09,.96,j,'bananaStem',[.48,.62,.2],1);
  }
  return {fruit:mango.geometry(),coconut:coconut.geometry(),banana:banana.geometry()};
}

/** Every tree in the inner range is detailed. The triangle cap applies only to optional outer candidates.
 * The refresh margin covers camera travel between pool rebuilds, so crossing 70 m never reveals an old tree.
 * Both pools retain the exact original instance records; shader-collapsed vertices still count on the GPU.
 */
export function selectCloseTrees(records, baseTriangles, detailTriangles, camera, radius=CLOSE_TREE_RADIUS) {
  const budget=Math.floor(records.reduce((sum,recs,sp) => sum+recs.length*(baseTriangles[sp]||0),0)*CLOSE_TREE_EXTRA_FRACTION);
  const candidates=[], chosen=records.map(() => new Set()); let mandatoryExtra=0, ringExtra=0, mandatoryCount=0;
  const fullRadius=Math.min(radius,CLOSE_TREE_FULL_RADIUS+CLOSE_TREE_REFRESH_MARGIN);
  records.forEach((recs,sp) => {
    if (!detailTriangles[sp]) return;
    recs.forEach((r,i) => {
      const d=Math.hypot(r[0]-camera.x,r[1]-camera.y,r[2]-camera.z);
      const cost=detailTriangles[sp]-(baseTriangles[sp]||0);
      if (radius>0 && d<=fullRadius) { chosen[sp].add(i); mandatoryExtra+=cost; mandatoryCount++; }
      else if (d<=radius && radius>0) candidates.push({sp,i,d,cost});
    });
  });
  // Distance order only: no species reservation can skip a nearer tree in the optional ring.
  candidates.sort((a,b) => a.d-b.d || a.sp-b.sp || a.i-b.i);
  for (const c of candidates) if (ringExtra+c.cost<=budget) { chosen[c.sp].add(c.i); ringExtra+=c.cost; }
  return { ordinary:records.map((r,sp) => chosen[sp].size ? r.filter((_,i) => !chosen[sp].has(i)) : r),
    close:records.map((r,sp) => r.filter((_,i) => chosen[sp].has(i))),
    extra:mandatoryExtra+ringExtra, budget, mandatoryExtra, mandatoryCount, ringExtra };
}
