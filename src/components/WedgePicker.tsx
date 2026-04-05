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
  frame_count: number;
  still_frame_ending: number;
  fps: number;
  quality: number;
  triangle_rotation_degrees_per_frame: number;
  hue_rotation_degrees_per_frame: number;
  zoom_max: number;
  zoom_min: number;
  zoom_fn: string;
  zoom_start_offset: number;
  num_zoom_loops: number;
};

interface PickerProps {
  imagePath: string;
  count: number;
  settings: Settings;
  onUpdate: (s: Settings) => void;
}

type ViewMetrics = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
};

export const WedgePicker: React.FC<PickerProps> = ({
  imagePath,
  count,
  settings,
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
    const viewportWidth = Math.max(1, Math.floor(wrapperRect.width));
    const viewportHeight = Math.max(1, Math.floor(wrapperRect.height));

    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    const fitScale = Math.min(
      viewportWidth / naturalWidth,
      viewportHeight / naturalHeight
    );

    const displayWidth = Math.max(1, Math.round(naturalWidth * fitScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * fitScale));

    const offsetX = Math.floor((viewportWidth - displayWidth) / 2);
    const offsetY = Math.floor((viewportHeight - displayHeight) / 2);

    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;

    canvas.width = viewportWidth;
    canvas.height = viewportHeight;
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;

    setMetrics({
      naturalWidth,
      naturalHeight,
      displayWidth,
      displayHeight,
      offsetX,
      offsetY,
      scaleX,
      scaleY,
    });

    ctx.clearRect(0, 0, viewportWidth, viewportHeight);

    ctx.fillStyle = "#020617";
    ctx.fillRect(0, 0, viewportWidth, viewportHeight);

    ctx.drawImage(image, offsetX, offsetY, displayWidth, displayHeight);

    const displayX = offsetX + settings.x * scaleX;
    const displayY = offsetY + settings.y * scaleY;

    const sliceAngle = (2 * Math.PI) / count;
    const sourceRadius = settings.resolution / (2 * settings.zoom);
    const visualRadius = sourceRadius * Math.min(scaleX, scaleY);

    ctx.save();
    ctx.translate(displayX, displayY);
    ctx.rotate(settings.rotation);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, visualRadius, 0, sliceAngle);
    ctx.lineTo(0, 0);
    ctx.closePath();

    ctx.strokeStyle = "#ff0000";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 0, 0, 0.3)";
    ctx.fill();

    ctx.restore();
  }, [count, settings]);

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

    const localX = ((clientX - rect.left) / rect.width) * canvas.width;
    const localY = ((clientY - rect.top) / rect.height) * canvas.height;

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

    const x = imageLocalX / currentMetrics.scaleX;
    const y = imageLocalY / currentMetrics.scaleY;

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