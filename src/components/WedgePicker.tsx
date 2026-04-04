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

type ViewState = {
  naturalWidth: number;
  naturalHeight: number;
  displayWidth: number;
  displayHeight: number;
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
  const [view, setView] = useState<ViewState | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const image = imageRef.current;
    const wrapper = wrapperRef.current;

    if (!canvas || !image || !wrapper) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const maxWidth = Math.max(1, Math.floor(wrapperRect.width));
    const maxHeight = Math.max(1, Math.floor(wrapperRect.height));

    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;

    if (naturalWidth <= 0 || naturalHeight <= 0) return;

    const fitScale = Math.min(maxWidth / naturalWidth, maxHeight / naturalHeight, 1);

    const displayWidth = Math.max(1, Math.round(naturalWidth * fitScale));
    const displayHeight = Math.max(1, Math.round(naturalHeight * fitScale));

    canvas.width = displayWidth;
    canvas.height = displayHeight;

    const scaleX = displayWidth / naturalWidth;
    const scaleY = displayHeight / naturalHeight;

    setView({
      naturalWidth,
      naturalHeight,
      displayWidth,
      displayHeight,
      scaleX,
      scaleY,
    });

    ctx.clearRect(0, 0, displayWidth, displayHeight);
    ctx.drawImage(image, 0, 0, displayWidth, displayHeight);

    const sliceAngle = (2 * Math.PI) / count;

    const displayX = settings.x * scaleX;
    const displayY = settings.y * scaleY;

    const sampleRadiusInSourcePixels = settings.resolution / (2 * settings.zoom);
    const visualRadius = sampleRadiusInSourcePixels * Math.min(scaleX, scaleY);

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
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = convertFileSrc(imagePath);

    img.onload = () => {
      imageRef.current = img;
      draw();
    };

    return () => {
      imageRef.current = null;
    };
  }, [imagePath, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const observer = new ResizeObserver(() => {
      draw();
    });

    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [draw]);

  useEffect(() => {
    const stopDragging = () => setIsDragging(false);
    window.addEventListener("mouseup", stopDragging);
    return () => window.removeEventListener("mouseup", stopDragging);
  }, []);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const currentView = view;
    if (!canvas || !currentView) return;

    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const clampedX = Math.min(Math.max(clientX - rect.left, 0), rect.width);
    const clampedY = Math.min(Math.max(clientY - rect.top, 0), rect.height);

    const imageX = (clampedX / rect.width) * currentView.naturalWidth;
    const imageY = (clampedY / rect.height) * currentView.naturalHeight;

    onUpdate({
      ...settings,
      x: imageX,
      y: imageY,
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
          maxWidth: "100%",
          maxHeight: "100%",
          width: "auto",
          height: "auto",
          cursor: isDragging ? "grabbing" : "crosshair",
        }}
      />
    </div>
  );
};