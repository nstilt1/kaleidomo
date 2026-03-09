import React, { useEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';

interface PickerProps {
  imagePath: string;
  count: number;
  settings: { x: number; y: number; rotation: number, resolution: number, zoom: number, tile_count: number }; // Pass settings as prop
  onUpdate: (s: { x: number; y: number; rotation: number, resolution: number, zoom: number, tile_count: number }) => void;
}

export const WedgePicker: React.FC<PickerProps> = ({ imagePath, count, settings, onUpdate }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [scale, setScale] = useState(1); // Scale: (Natural Width / Display Width)
  const [isDragging, setIsDragging] = useState(false);

  const displayWidth = 800; // Constrain the UI to 800px wide

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    
    img.src = convertFileSrc(imagePath);
    img.onload = () => {
      const s = img.width / displayWidth;
      setScale(s);
      canvas.width = displayWidth;
      canvas.height = img.height / s;
      draw(img, ctx);
    };

    const draw = (image: HTMLImageElement, context: CanvasRenderingContext2D) => {
      // 1. Force the canvas size to match the display constraints
      const s = image.naturalWidth / displayWidth;
      context.canvas.width = displayWidth;
      context.canvas.height = image.naturalHeight / s;
      const visualRadius = (settings.resolution / 2) / (scale * settings.zoom);

      // 2. Draw the background image
      context.drawImage(image, 0, 0, context.canvas.width, context.canvas.height);

      // 3. Draw the Wedge (The Triangle)
      const sliceAngle = (2 * Math.PI) / count;
      
      // Convert 'real' pixel coordinates from Rust-space back to 'canvas' space
      const displayX = settings.x / s;
      const displayY = settings.y / s;

      context.save();
      context.translate(displayX, displayY);
      context.rotate(settings.rotation);
      
      context.beginPath();
      context.moveTo(0, 0);
      context.arc(0, 0, visualRadius, 0, sliceAngle); // 100px radius for visibility
      context.lineTo(0, 0);
      context.closePath();
      
      // Make it VERY visible for debugging
      context.strokeStyle = '#ff0000'; // Bright Red
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = 'rgba(255, 0, 0, 0.3)';
      context.fill();
      
      context.restore();
    };
  }, [imagePath, count, settings, scale]);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !canvasRef.current) return;
    
    const rect = canvasRef.current.getBoundingClientRect();
    
    // 1. Get mouse position relative to the element (0 to displayWidth)
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // 2. Map screen pixels to internal canvas pixels 
    // (In case the CSS is slightly different from the displayWidth)
    const canvasX = (mouseX / rect.width) * canvasRef.current.width;
    const canvasY = (mouseY / rect.height) * canvasRef.current.height;

    // 3. Update the UI state (in canvas-space for drawing)
    // 4. Send the SCALED coordinates to the parent (image-space for Rust)
    onUpdate({
      x: canvasX * scale,
      y: canvasY * scale,
      rotation: settings.rotation,
      resolution: settings.resolution,
      zoom: settings.zoom,
      tile_count: settings.tile_count,
    });
  };

  return (
    <div className="relative border shadow-inner bg-slate-950 overflow-hidden">
      <canvas 
        ref={canvasRef}
        onMouseDown={() => setIsDragging(true)}
        onMouseUp={() => setIsDragging(false)}
        onMouseMove={handleMouseMove}
        style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
      />
  </div>
  );
};