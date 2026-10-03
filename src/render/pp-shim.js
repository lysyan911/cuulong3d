// Stand-in for the "postprocessing" library: N8AO imports its Pass class only to define N8AOPostPass, which this
// project doesn't use (we use N8AOPass with three's EffectComposer). Saves loading ~600 KB.
export class Pass {}
