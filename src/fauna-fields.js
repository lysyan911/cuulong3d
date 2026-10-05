// Tile-spawn checks use the real terrain GLSL; CPU float hashes can disagree with the GPU.
import * as THREE from 'three';
import {FIELD} from './surface.js';

let sourcePromise;
async function fieldSource(){
  if(!sourcePromise)sourcePromise=fetch(new URL('./shaders.js',import.meta.url)).then(async r=>{
    if(!r.ok)throw Error('Fauna field shader source unavailable');
    const text=await r.text(),a=text.indexOf('float hash12'),b=text.indexOf('float fbm',a),c=text.indexOf('float ca = cos(uField.z)'),d=text.indexOf('float lw = min(1.0',c);
    if(a<0||b<=a||c<0||d<=c)throw Error('Fauna field shader markers changed');
    const common=text.slice(a,b),stage=text.slice(c,d);
    if(!common.includes('float vnoise')||!stage.includes('float stage ='))throw Error('Fauna field shader extraction incomplete');
    return {common,stage};
  });
  return sourcePromise;
}

export class FieldClassifier {
  // No renderer means no GPU evidence; callers must skip field candidates rather than trust the CPU twin.
  static async create(renderer){
    if(!renderer)return null;
    if(!renderer.isWebGLRenderer||typeof renderer.getContext().createVertexArray!=='function')throw Error('Fauna fields require WebGL2');
    const classifier=new FieldClassifier(renderer,await fieldSource());
    try{classifier.classify([0,0]);return classifier;}
    catch(e){classifier.dispose();throw e;}
  }

  constructor(renderer,{common,stage}){
    this.renderer=renderer;this.dead=false;this.capacity=0;
    const edge=Math.floor(renderer.capabilities.maxTextureSize);
    if(!Number.isFinite(edge)||edge<1)throw Error('Fauna field texture limits unavailable');
    this.width=Math.min(256,edge);this.maxPoints=Math.min(1048576,this.width*edge);
    this.target=new THREE.WebGLRenderTarget(1,1,{format:THREE.RGBAFormat,type:THREE.UnsignedByteType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
    this.target.texture.colorSpace=THREE.NoColorSpace;this.target.texture.generateMipmaps=false;
    this.uniforms={uGrid:{value:new THREE.Vector2(1,1)},uField:{value:new THREE.Vector4(FIELD.block[0],FIELD.block[1],FIELD.angle,FIELD.bundHeight)}};
    this.material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:this.uniforms,depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false,
      vertexShader:`flat out vec2 P;
uniform vec2 uGrid;
void main(){
  P=position.xy;
  int width=int(uGrid.x);
  vec2 pixel=vec2(float(gl_VertexID%width),float(gl_VertexID/width))+.5;
  gl_Position=vec4(pixel/uGrid*2.-1.,0.,1.);
  gl_PointSize=1.;
}`,
      fragmentShader:`precision highp float;
flat in vec2 P;
uniform vec4 uField;
out vec4 fieldColour;
${common}
void main(){
${stage}
  fieldColour=vec4(stage,0.,0.,1.);
}`});
    this.geometry=new THREE.BufferGeometry();this.points=new THREE.Points(this.geometry,this.material);this.points.frustumCulled=false;
    this.points.userData.noShadow=true;this.points.userData.noReflect=true;
    this.scene=new THREE.Scene();this.scene.add(this.points);this.camera=new THREE.Camera();
  }

  // Flat [east,north,...], in raw scene metres. Bytes are nearest RGBA8 stage values.
  // Use byte/255 with a half-byte safety margin for strict <.18 / >.92 eligibility.
  classify(points){
    if(this.dead)throw Error('Fauna field classifier disposed');
    if(!points||!Number.isInteger(points.length)||points.length%2)throw Error('Fauna field points must be flat XY pairs');
    const count=points.length/2;if(!count)return new Uint8Array(0);
    if(count>this.maxPoints)throw Error('Fauna field batch exceeds '+this.maxPoints+' points');
    for(let i=0;i<points.length;i++)if(!Number.isFinite(points[i]))throw Error('Fauna field point is not finite');
    const renderer=this.renderer,gl=renderer.getContext();
    if(gl.isContextLost())throw Error('Fauna field WebGL context lost');
    if(count>this.capacity){
      this.geometry.dispose();this.geometry=new THREE.BufferGeometry();this.points.geometry=this.geometry;
      this.capacity=Math.min(this.maxPoints,2**Math.ceil(Math.log2(count)));
      this.attribute=new THREE.BufferAttribute(new Float32Array(this.capacity*3),3);this.attribute.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position',this.attribute);
    }
    for(let i=0;i<count;i++){this.attribute.array[i*3]=points[i*2];this.attribute.array[i*3+1]=points[i*2+1];this.attribute.array[i*3+2]=0;}
    this.attribute.needsUpdate=true;this.geometry.setDrawRange(0,count);
    // Shader coordinates are unrelated to world bounds; Points sorting still asks for a sphere.
    this.geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),1);
    const width=Math.min(this.width,count),height=Math.ceil(count/width);
    if(this.target.width!==width||this.target.height!==height)this.target.setSize(width,height);
    this.target.viewport.set(0,0,width,height);this.target.scissor.set(0,0,width,height);this.target.scissorTest=false;
    this.uniforms.uGrid.value.set(width,height);
    const bytes=new Uint8Array(width*height*4);
    const saved={target:renderer.getRenderTarget(),cube:renderer.getActiveCubeFace(),mip:renderer.getActiveMipmapLevel(),
      viewport:renderer.getViewport(new THREE.Vector4()),currentViewport:renderer.getCurrentViewport(new THREE.Vector4()),
      scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),
      currentScissor:new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)),currentScissorTest:gl.isEnabled(gl.SCISSOR_TEST),
      clear:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),autoClear:renderer.autoClear,
      xr:renderer.xr.enabled,shadow:renderer.shadowMap.autoUpdate,infoReset:renderer.info.autoReset,renderInfo:{...renderer.info.render},
      debugCheck:renderer.debug.checkShaderErrors,debugError:renderer.debug.onShaderError};
    let shaderError=null;
    try{
      renderer.xr.enabled=false;renderer.shadowMap.autoUpdate=false;renderer.info.autoReset=false;renderer.autoClear=false;
      renderer.debug.checkShaderErrors=true;
      renderer.debug.onShaderError=(context,program,vertex,fragment)=>{
        shaderError=[context.getProgramInfoLog(program),context.getShaderInfoLog(vertex),context.getShaderInfoLog(fragment)].filter(Boolean).join('\n')||'Fauna field shader did not link';
      };
      renderer.setRenderTarget(this.target);renderer.setClearColor(0,0);renderer.clear(true,false,false);
      renderer.render(this.scene,this.camera);
      if(shaderError)throw Error(shaderError);
      renderer.readRenderTargetPixels(this.target,0,0,width,height,bytes);
      if(gl.isContextLost())throw Error('Fauna field readback context lost');
      const stages=new Uint8Array(count);
      for(let i=0;i<count;i++){
        if(bytes[i*4+3]!==255)throw Error('Fauna field readback incomplete at point '+i);
        stages[i]=bytes[i*4];
      }
      return stages;
    }finally{
      renderer.debug.checkShaderErrors=saved.debugCheck;renderer.debug.onShaderError=saved.debugError;
      renderer.xr.enabled=saved.xr;renderer.shadowMap.autoUpdate=saved.shadow;renderer.autoClear=saved.autoClear;
      renderer.setClearColor(saved.clear,saved.alpha);
      // We do not change canvas viewport/scissor settings. setRenderTarget restores target-specific state.
      renderer.setRenderTarget(saved.target,saved.cube,saved.mip);
      // Preserve explicit viewport/scissor overrides made after the previous target was bound.
      if(!renderer.getCurrentViewport(new THREE.Vector4()).equals(saved.currentViewport))renderer.setViewport(saved.viewport);
      if(!new THREE.Vector4().fromArray(gl.getParameter(gl.SCISSOR_BOX)).equals(saved.currentScissor))renderer.setScissor(saved.scissor);
      if(gl.isEnabled(gl.SCISSOR_TEST)!==saved.currentScissorTest)renderer.setScissorTest(saved.scissorTest);
      renderer.info.autoReset=saved.infoReset;Object.assign(renderer.info.render,saved.renderInfo);
    }
  }

  dispose(){
    if(this.dead)return;this.dead=true;
    this.geometry.dispose();this.material.dispose();this.target.dispose();this.scene.clear();
    this.attribute=null;this.renderer=null;
  }
}
