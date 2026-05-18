let readyPromise = null;

export async function ensureThree() {
  if (window.THREE?.GLTFLoader && window.THREE?.OrbitControls) {
    return window.THREE;
  }

  if (!readyPromise) {
    readyPromise = Promise.all([
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/STLLoader.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/environments/RoomEnvironment.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/exporters/STLExporter.js'),
      import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/3MFLoader.js')
    ]).then(([
      THREE_NS,
      { GLTFLoader },
      { STLLoader },
      { OrbitControls },
      { RoomEnvironment },
      { STLExporter },
      { ThreeMFLoader }
    ]) => {
      const THREE_MUT = Object.assign({}, THREE_NS);
      THREE_MUT.GLTFLoader = GLTFLoader;
      THREE_MUT.STLLoader = STLLoader;
      THREE_MUT.ThreeMFLoader = ThreeMFLoader;
      THREE_MUT.OrbitControls = OrbitControls;
      THREE_MUT.RoomEnvironment = RoomEnvironment;
      THREE_MUT.STLExporter = STLExporter;

      window.THREE = THREE_MUT;
      window.dispatchEvent(new Event('three-ready'));
      return THREE_MUT;
    });
  }

  return readyPromise;
}

export function initThreeScene() {
  return ensureThree();
}
