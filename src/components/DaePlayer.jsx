import { useState, useEffect, useCallback, useRef } from 'react';
import { daePlay, daePause, daeSeek, daeRestart, setDaeCallbacks } from '../engine/daeScene.js';
import './DaePlayer.css';

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function DaePlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime]   = useState(0);
  const [duration, setDuration]   = useState(0);
  const scrubbing = useRef(false);

  // Brancher les callbacks de daeScene vers ce composant
  useEffect(() => {
    setDaeCallbacks(
      (t, d) => { if (!scrubbing.current) { setCurrentTime(t); setDuration(d); } },
      (playing) => setIsPlaying(playing),
    );
    return () => setDaeCallbacks(null, null);
  }, []);

  const handleScrubChange = useCallback((e) => {
    const t = parseFloat(e.target.value);
    setCurrentTime(t);
    daeSeek(t);
  }, []);

  const handleScrubStart = useCallback(() => { scrubbing.current = true;  daePause(); }, []);
  const handleScrubEnd   = useCallback((e) => {
    scrubbing.current = false;
    daeSeek(parseFloat(e.target.value));
  }, []);

  const progress = duration > 0 ? currentTime / duration : 0;

  return (
    <div className="dae-player">
      {/* Barre de progression */}
      <div className="dae-scrub-wrap">
        <input
          type="range"
          className="dae-scrub"
          min={0}
          max={duration || 1}
          step={0.001}
          value={currentTime}
          style={{ '--progress': `${progress * 100}%` }}
          onChange={handleScrubChange}
          onMouseDown={handleScrubStart}
          onTouchStart={handleScrubStart}
          onMouseUp={handleScrubEnd}
          onTouchEnd={handleScrubEnd}
        />
      </div>

      {/* Contrôles */}
      <div className="dae-controls">
        {/* Retour au début */}
        <button className="dae-btn" onClick={daeRestart} title="Retour au début">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
          </svg>
        </button>

        {/* Play / Pause */}
        <button className="dae-btn dae-btn--play" onClick={isPlaying ? daePause : daePlay} title={isPlaying ? 'Pause' : 'Lecture'}>
          {isPlaying ? (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6zm8-14v14h4V5z"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          )}
        </button>

        {/* Timecode */}
        <span className="dae-time">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </div>
    </div>
  );
}
