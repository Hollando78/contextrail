// The desklet bundle (esbuild) imports xterm's stylesheet; tsc only needs to
// know the module exists.
declare module '*.css';
