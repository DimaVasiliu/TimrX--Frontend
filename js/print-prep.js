/**
 * print-prep.js
 * Print Preparation panel — shows real-world dimensions, lets users set
 * target print height, and exports print-ready STL directly.
 */

// State
let _printPrepModel = null;  // Reference to the current Three.js model
let _printPrepData = null;   // Last print analysis result

/**
 * Detect the unit system of a loaded model based on bounding box heuristics.
 * Returns { detectedUnit, mmScale, sizeMM: {x, y, z} }
 */
export function detectModelUnits(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    let detectedUnit = 'mm';
    let mmScale = 1.0;

    if (maxDim > 0 && maxDim < 10) {
        detectedUnit = 'meters';
        mmScale = 1000.0;
    } else if (maxDim >= 10 && maxDim < 100) {
        detectedUnit = 'cm_or_mm';
        mmScale = 1.0; // Assume mm, user can override
    }

    return {
        detectedUnit,
        mmScale,
        sizeMM: {
            x: parseFloat((size.x * mmScale).toFixed(2)),
            y: parseFloat((size.y * mmScale).toFixed(2)),
            z: parseFloat((size.z * mmScale).toFixed(2)),
        },
        originalSize: { x: size.x, y: size.y, z: size.z },
    };
}

/**
 * Render the print-prep dimensions display inside the given container.
 */
export function renderDimensionsDisplay(container, unitInfo) {
    if (!container) return;
    const s = unitInfo.sizeMM;
    container.innerHTML = `
        <div class="print-prep-dimensions">
            <div class="print-prep-dim-row">
                <span class="print-prep-dim-label">Width (X)</span>
                <span class="print-prep-dim-value">${s.x} mm</span>
            </div>
            <div class="print-prep-dim-row">
                <span class="print-prep-dim-label">Height (Y)</span>
                <span class="print-prep-dim-value">${s.y} mm</span>
            </div>
            <div class="print-prep-dim-row">
                <span class="print-prep-dim-label">Depth (Z)</span>
                <span class="print-prep-dim-value">${s.z} mm</span>
            </div>
            <div class="print-prep-dim-note">
                Detected source unit: <strong>${unitInfo.detectedUnit}</strong>
            </div>
        </div>
    `;
}

/**
 * Compute the uniform scale factor to achieve a target height in mm.
 * @param {object} unitInfo - From detectModelUnits()
 * @param {number} targetHeightMM - Desired height in millimeters
 * @returns {number} Scale factor to apply to model (in original units) to get mm
 */
export function computePrintScale(unitInfo, targetHeightMM) {
    if (!targetHeightMM || targetHeightMM <= 0) {
        // No target — just convert to mm
        return unitInfo.mmScale;
    }
    // Scale so that model height * factor = targetHeightMM
    // currentHeightMM = originalSize.y * mmScale
    const currentHeightMM = unitInfo.sizeMM.y;
    if (currentHeightMM <= 0) return unitInfo.mmScale;
    return (targetHeightMM / unitInfo.originalSize.y);
}

/**
 * Export the current viewer model as a print-ready STL.
 * Undoes viewport display scale, applies mm conversion + optional target height.
 * @param {THREE.Object3D} model - The Three.js model
 * @param {number} displayScale - The viewport scale that was applied
 * @param {object} unitInfo - From detectModelUnits()
 * @param {number} targetHeightMM - Optional target height in mm (0 = use original)
 * @param {string} filename - Output filename
 */
export function exportPrintReadySTL(model, displayScale, unitInfo, targetHeightMM, filename) {
    if (!model || !window.THREE) return;

    const exporter = new THREE.STLExporter();

    // Compute export scale: undo display scale, apply mm conversion
    const printScale = computePrintScale(unitInfo, targetHeightMM);
    const exportScale = printScale / displayScale;

    // Clone model for export
    const exportClone = model.clone();
    exportClone.scale.setScalar(exportScale);
    exportClone.updateMatrixWorld(true);

    const result = exporter.parse(exportClone, { binary: true });
    const blob = new Blob([result], { type: 'application/octet-stream' });

    // Download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'model_print_ready.stl';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}
