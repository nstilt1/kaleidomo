import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Settings } from "@/lib/kaleidomo-session-context";

interface PickerProps {
  imagePath: string;
  count: number;
  settings: Settings;
  sourceRadiusPx: number;
  onUpdate: (s: Settings) => void;
}

type ViewMetrics = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  offsetX: number;
  offsetY: number;
  fitScale: number;
};

type CirclePickStep = "idle" | "picking_first" | "picking_second";

/** Mirror of the Rust orientation_to_hero_params_with_circle logic */
function orientationToHeroParams(
  value: number,
  leftX: number,
  rightX: number,
  centerY: number,
  desiredLeftRotation: number,
) {
  const centerX = (leftX + rightX) / 2;
  const radius = (rightX - leftX) / 2;
  const circleAngle = Math.PI + value * Math.PI * 2;
  const triangleCenterX = centerX + Math.cos(circleAngle) * radius;
  const triangleCenterY = centerY + Math.sin(circleAngle) * radius;
  const triangleRotationRad = desiredLeftRotation + (circleAngle - Math.PI);
  return { triangleCenterX, triangleCenterY, triangleRotationRad };
}

/** Given the current rotation_start_offset and orientation phase, compute
 *  what desiredLeftRotation must be so that the rendered rotation at phase=0
 *  matches the wedge picker's current rotation setting. */
function computeDesiredLeftRotation(
  currentRotationRad: number,
  orientationPhase: number,
  _leftX: number,
  _rightX: number,
  _centerY: number,
): number {
  // At orientation phase 0, circleAngle = PI.
  // triangleRotationRad = desiredLeftRotation + (circleAngle - PI)
  //                     = desiredLeftRotation + 0  (at phase 0)
  // So at phase=0, triangleRotationRad == desiredLeftRotation.
  // For a non-zero phase we need to back out the angle contribution:

  const circleAngle = Math.PI + orientationPhase * Math.PI * 2;
  // What rotation does the circle geometry contribute at this phase?
  const geometryContribution = circleAngle - Math.PI;
  // We want: currentRotationRad = desiredLeftRotation + geometryContribution
  return currentRotationRad - geometryContribution;
}

export const WedgePicker: React.FC<PickerProps> = ({
  imagePath,
  count,
  settings,
  sourceRadiusPx,
  onUpdate,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [metrics, setMetrics] = useState<ViewMetrics | null>(null);
  const [circlePickStep, setCirclePickStep] = useState<CirclePickStep>("idle");
  const [firstPoint, setFirstPoint] = useState<{ x: number; y: number } | null>(null);

  // ---------------------------------------------------------------------------
  // Draw
  // ---------------------------------------------------------------------------
  const draw = useCallback(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    const image = imageRef.current;
    if (!wrapper || !canvas || !image) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const viewportWidth = Math.max(1, wrapperRect.width);
    const viewportHeight = Math.max(1, wrapperRect.height);

    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    const fitScale = Math.min(
      viewportWidth / naturalWidth,
      viewportHeight / naturalHeight,
    );

    const displayWidth = Math.max(1, naturalWidth * fitScale);
    const displayHeight = Math.max(1, naturalHeight * fitScale);

    const offsetX = (viewportWidth - displayWidth) / 2;
    const offsetY = (viewportHeight - displayHeight) / 2;

    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.max(1, Math.round(viewportWidth * dpr));
    canvas.height = Math.max(1, Math.round(viewportHeight * dpr));
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewportWidth, viewportHeight);

    setMetrics({
      naturalWidth,
      naturalHeight,
      displayWidth,
      displayHeight,
      offsetX,
      offsetY,
      fitScale,
    });

    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    ctx.drawImage(image, offsetX, offsetY, displayWidth, displayHeight);

    // --- Wedge (source picker) overlay ---
    const displayX = offsetX + settings.x * fitScale;
    const displayY = offsetY + settings.y * fitScale;

    const sliceAngle = (2 * Math.PI) / count;
    const visualRadius = sourceRadiusPx * fitScale;

    ctx.save();
    ctx.translate(displayX, displayY);
    ctx.rotate(settings.rotation);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, visualRadius, 0, sliceAngle);
    ctx.lineTo(0, 0);
    ctx.closePath();

    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 0, 0, 0.22)";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, 2 * Math.PI);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    ctx.restore();

    // --- Hero circle overlay (always visible) ---
    const lx = offsetX + settings.heroCircleLeftX * fitScale;
    const rx = offsetX + settings.heroCircleRightX * fitScale;
    const cy = offsetY + settings.heroCircleY * fitScale;
    const cxCircle = (lx + rx) / 2;
    const rCircle = (rx - lx) / 2;

    ctx.save();
    ctx.strokeStyle = "rgba(0, 200, 255, 0.5)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(cxCircle, cy, rCircle, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Left and right endpoint dots
    ctx.fillStyle = "rgba(0, 200, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(lx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(rx, cy, 5, 0, Math.PI * 2);
    ctx.fill();

    // Current orientation position on the circle
    const { triangleCenterX, triangleCenterY } = orientationToHeroParams(
      settings.orientationPhase,
      settings.heroCircleLeftX,
      settings.heroCircleRightX,
      settings.heroCircleY,
      6.22, // desiredLeftRotation — visual only, doesn't affect dot position
    );
    const dotDx = offsetX + triangleCenterX * fitScale;
    const dotDy = offsetY + triangleCenterY * fitScale;
    ctx.fillStyle = "rgba(255, 220, 0, 0.95)";
    ctx.beginPath();
    ctx.arc(dotDx, dotDy, 6, 0, Math.PI * 2);
    ctx.fill();

    // First point during circle picking
    if (firstPoint) {
      const fpx = offsetX + firstPoint.x * fitScale;
      const fpy = offsetY + firstPoint.y * fitScale;
      ctx.strokeStyle = "rgba(0, 200, 255, 1)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(fpx, fpy, 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }, [count, settings, sourceRadiusPx, firstPoint]);

  // ---------------------------------------------------------------------------
  // Image loading
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!imagePath || imagePath.trim() === "") {
      imageRef.current = null;
      return;
    }

    const img = new Image();
    img.crossOrigin = "anonymous";
    const src = convertFileSrc(imagePath);

    img.onload = () => {
      imageRef.current = img;
      draw();
    };

    img.onerror = (event) => {
      console.error("WedgePicker image failed to load", { imagePath, src, event });
      imageRef.current = null;
    };

    img.src = src;
    return () => { imageRef.current = null; };
  }, [imagePath, draw]);

  // Resize observer
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;

    const redraw = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => { draw(); });
      });
    };

    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver(redraw);
    observer.observe(wrapper);
    window.addEventListener("resize", redraw);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redraw);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [draw]);

  useEffect(() => {
    const stopDragging = () => setIsDragging(false);
    window.addEventListener("mouseup", stopDragging);
    return () => window.removeEventListener("mouseup", stopDragging);
  }, []);

  // ---------------------------------------------------------------------------
  // Pointer → image coords
  // ---------------------------------------------------------------------------
  const clientToImageCoords = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    const m = metrics;
    if (!canvas || !m) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const imageLocalX = localX - m.offsetX;
    const imageLocalY = localY - m.offsetY;

    if (imageLocalX < 0 || imageLocalY < 0 || imageLocalX > m.displayWidth || imageLocalY > m.displayHeight) {
      return null;
    }

    return { x: imageLocalX / m.fitScale, y: imageLocalY / m.fitScale };
  };

  // ---------------------------------------------------------------------------
  // Pointer handlers
  // ---------------------------------------------------------------------------
  const handlePointerDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = clientToImageCoords(e.clientX, e.clientY);
    if (!coords) return;

    if (circlePickStep === "picking_first") {
      setFirstPoint(coords);
      setCirclePickStep("picking_second");
      return;
    }

    if (circlePickStep === "picking_second" && firstPoint) {
      // Two points define a diameter — leftX is the min-x point, rightX the max-x.
      // centerY is the average y of both points.
      const leftX = Math.min(firstPoint.x, coords.x);
      const rightX = Math.max(firstPoint.x, coords.x);
      const centerY = (firstPoint.y + coords.y) / 2;

      // Recompute desiredLeftRotation so the existing rotation_start_offset still
      // produces the right triangle rotation at orientationPhase = 0.
      const desiredLeftRotation = computeDesiredLeftRotation(
        settings.rotation,
        settings.orientationPhase,
        leftX,
        rightX,
        centerY,
      );

      onUpdate({
        ...settings,
        heroCircleLeftX: leftX,
        heroCircleRightX: rightX,
        heroCircleY: centerY,
        rotation: desiredLeftRotation,
      });

      setFirstPoint(null);
      setCirclePickStep("idle");
      return;
    }

    // Normal wedge-drag mode
    setIsDragging(true);
    onUpdate({ ...settings, x: coords.x, y: coords.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging || circlePickStep !== "idle") return;
    const coords = clientToImageCoords(e.clientX, e.clientY);
    if (!coords) return;
    onUpdate({ ...settings, x: coords.x, y: coords.y });
  };

  const cancelCirclePick = () => {
    setCirclePickStep("idle");
    setFirstPoint(null);
  };

  // ---------------------------------------------------------------------------
  // Cursor style
  // ---------------------------------------------------------------------------
  const cursor =
    circlePickStep !== "idle" ? "crosshair" :
    isDragging ? "grabbing" : "crosshair";

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-2 px-2 py-1.5 border-b border-border bg-muted/40">
        {circlePickStep === "idle" ? (
          <button
            type="button"
            className="rounded px-2 py-1 text-xs border border-border bg-background hover:bg-accent"
            onClick={() => setCirclePickStep("picking_first")}
          >
            Set circle center
          </button>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {circlePickStep === "picking_first"
                ? "Click the LEFT point of the circle diameter"
                : "Click the RIGHT point of the circle diameter"}
            </span>
            <button
              type="button"
              className="ml-auto rounded px-2 py-1 text-xs border border-border bg-background hover:bg-accent"
              onClick={cancelCirclePick}
            >
              Cancel
            </button>
          </>
        )}
      </div>

      {/* Canvas */}
      <div
        ref={wrapperRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-b-lg bg-slate-950"
      >
        <canvas
          ref={canvasRef}
          onMouseDown={handlePointerDown}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setIsDragging(false)}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            cursor,
          }}
        />
      </div>
    </div>
  );
};