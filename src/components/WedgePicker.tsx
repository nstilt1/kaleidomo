import React, { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

type Settings = {
  x: number;
  y: number;
  rotation: number;
  resolution: number;
  zoom: number;
  tile_count: number;
  hue_rotate: number;
  ratio_num: number;
  ratio_den: number;
  offset_x: number;
  offset_y: number;
  aspect_ratio_mode: string;
  still_frame_ending: number;
  fps: number;
  quality: number;
  zoom_max: number;
  zoom_min: number;
  zoom_fn: string;
  zoom_start_offset: number;
  num_zoom_loops: number;
  animation_duration: number;
  rotation_range: number;
  rotation_cycles: number;
  rotation_start_offset: number;
  rotation_fn: string;
  hue_range: number;
  hue_cycles: number;
  hue_start_offset: number;
  hue_fn: string;
};

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
      viewportHeight / naturalHeight
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
  }, [count, settings, sourceRadiusPx]);

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
      console.error("WedgePicker image failed to load", {
        imagePath,
        src,
        event,
      });
      imageRef.current = null;
    };

    img.src = src;

    return () => {
      imageRef.current = null;
    };
  }, [imagePath, draw]);

  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;

    const redraw = () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);

      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          draw();
        });
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

  const updateFromPointer = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const currentMetrics = metrics;
    if (!canvas || !currentMetrics) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;

    const imageLocalX = localX - currentMetrics.offsetX;
    const imageLocalY = localY - currentMetrics.offsetY;

    if (
      imageLocalX < 0 ||
      imageLocalY < 0 ||
      imageLocalX > currentMetrics.displayWidth ||
      imageLocalY > currentMetrics.displayHeight
    ) {
      return;
    }

    const x = imageLocalX / currentMetrics.fitScale;
    const y = imageLocalY / currentMetrics.fitScale;

    onUpdate({
      ...settings,
      x,
      y,
    });
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    setIsDragging(true);
    updateFromPointer(e.clientX, e.clientY);
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDragging) return;
    updateFromPointer(e.clientX, e.clientY);
  };

  return (
    <div
      ref={wrapperRef}
      className="flex h-full w-full items-center justify-center overflow-hidden rounded-lg border shadow-inner bg-slate-950"
    >
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setIsDragging(false)}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          cursor: isDragging ? "grabbing" : "crosshair",
        }}
      />
    </div>
  );
};