// bat-model.js — procedural cricket bat geometry for Three.js
// Loaded by index.html via <script src="bat-model.js"> (optional; inline fallback exists).
// Exposes createBat() returning a THREE.Group.
(function () {
  window.createBat = function () {
    const bat = new THREE.Group();
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 0.9, 16),
      new THREE.MeshStandardMaterial({ color: 0x654321 })
    );
    handle.rotation.x = Math.PI / 2;
    handle.position.y = 0.45;
    bat.add(handle);

    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.16, 0.78, 0.07),
      new THREE.MeshStandardMaterial({ color: 0xD2B48C })
    );
    blade.position.y = 0.28;
    blade.position.z = 0.12;
    bat.add(blade);

    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.72),
      new THREE.MeshStandardMaterial({ color: 0xE8DCC4, side: THREE.DoubleSide })
    );
    face.position.z = 0.041;
    blade.add(face);

    return bat;
  };
})();
