import { useState, useEffect, useMemo } from 'react';
import './NavMenu.css';

const MODE_ICONS = {
  fps:     '🎮',
  orbit:   '🔭',
  toggle:  '🔄',
  geojson: '🗺️',
  physics: '🏛️',
  dae:     '🎬',
  help:    '❓',
};

const MODE_LABELS = {
  fps:     'Vue FPS',
  orbit:   'Orbite',
  toggle:  'FPS + Orbit',
  geojson: 'Carte',
  physics: 'Physique',
  dae:     'Animation',
  help:    'Aide',
};

const CATEGORY_ICONS = {
  'Aide':          '📖',
  'Chapiteaux':    '🏛️',
  'Sculptures':    '🗿',
  'Animations':    '🎬',
  'Explorations':  '🚶',
  'Vue générale':  '🌐',
  'Cartographie':  '🗺️',
};

function groupByCategory(pages) {
  const seen = [];
  const map = {};
  pages.forEach((page) => {
    const cat = page.category || 'Autres';
    if (!map[cat]) {
      map[cat] = [];
      seen.push(cat);
    }
    map[cat].push(page);
  });
  return seen.map((name) => ({ name, pages: map[name] }));
}

/**
 * Menu de navigation superposé à la scène Three.js.
 * Le menu reste affiché sans jamais démonter le canvas.
 */
export default function NavMenu({ pages, currentPageId, onNavigate, isLoading }) {
  const [open, setOpen] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);
  const [openCategories, setOpenCategories] = useState({});

  const currentPage = pages.find((p) => p.id === currentPageId);
  const categories = useMemo(() => groupByCategory(pages), [pages]);

  // Initialiser toutes les catégories ouvertes au premier chargement
  useEffect(() => {
    if (categories.length === 0) return;
    setOpenCategories((prev) => {
      const next = { ...prev };
      categories.forEach(({ name }) => {
        if (next[name] === undefined) next[name] = true;
      });
      return next;
    });
  }, [categories]);

  // Suivre l'état du pointer lock pour adapter les hints
  useEffect(() => {
    const onChange = () => {
      setPointerLocked(!!document.pointerLockElement);
    };
    document.addEventListener('pointerlockchange', onChange);
    return () => document.removeEventListener('pointerlockchange', onChange);
  }, []);

  // Fermer le menu quand on quitte la page (pointer lock récupéré)
  useEffect(() => {
    if (pointerLocked) setOpen(false);
  }, [pointerLocked]);

  const handleNavigate = (id) => {
    if (id === currentPageId) { setOpen(false); return; }
    onNavigate(id);
    setOpen(false);
  };

  const toggleCategory = (name) => {
    setOpenCategories((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <>
      {/* ── Bouton hamburger ─────────────────────────────────────── */}
      <button
        className="nav-toggle"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Fermer le menu' : 'Ouvrir le menu'}
        aria-label="Menu"
      >
        <span className={`hamburger ${open ? 'open' : ''}`} />
      </button>

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <nav className={`nav-sidebar ${open ? 'visible' : ''}`}>
        <h2 className="nav-title">Mes créations</h2>

        <div className="nav-categories">
          {categories.map(({ name, pages: catPages }) => {
            const isOpen = openCategories[name] !== false;
            const icon = CATEGORY_ICONS[name] || '📁';
            const hasActive = catPages.some((p) => p.id === currentPageId);

            return (
              <div key={name} className="nav-category">
                {/* ── En-tête de catégorie ── */}
                <button
                  className={`nav-category-header ${hasActive ? 'has-active' : ''}`}
                  onClick={() => toggleCategory(name)}
                >
                  <span className="nav-category-icon">{icon}</span>
                  <span className="nav-category-name">{name}</span>
                  <span className={`nav-category-arrow ${isOpen ? 'open' : ''}`}>›</span>
                </button>

                {/* ── Items de la catégorie ── */}
                <ul className={`nav-list ${isOpen ? 'expanded' : 'collapsed'}`}>
                  {catPages.map((page) => (
                    <li key={page.id}>
                      <button
                        className={`nav-item ${page.id === currentPageId ? 'active' : ''}`}
                        onClick={() => handleNavigate(page.id)}
                        disabled={isLoading}
                      >
                        <span className="nav-icon">{MODE_ICONS[page.controls]}</span>
                        <span className="nav-label">{page.name}</span>
                        <span className="nav-mode">{MODE_LABELS[page.controls]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </nav>

      {/* ── Overlay sombre quand sidebar ouverte ─────────────────── */}
      {open && (
        <div className="nav-backdrop" onClick={() => setOpen(false)} />
      )}

      {/* ── Indicateur de chargement ─────────────────────────────── */}
      {isLoading && (
        <div className="nav-loading">
          <div className="nav-spinner" />
          <span>Chargement…</span>
        </div>
      )}

      {/* ── Hint FPS (mode pointer lock actif) ───────────────────── */}
      {!open && !isLoading && currentPage?.controls === 'fps' && !pointerLocked && (
        <div className="nav-hint fps-hint">
          Cliquez sur la scène pour capturer la souris &nbsp;·&nbsp; <kbd>ESC</kbd> pour le menu
        </div>
      )}

      {/* ── Hint Orbit / GeoJSON ─────────────────────────────────── */}
      {!open && !isLoading && (currentPage?.controls === 'orbit' || currentPage?.controls === 'geojson') && (
        <div className="nav-hint orbit-hint">
          Clic + glisser pour tourner &nbsp;·&nbsp; Scroll pour zoomer
        </div>
      )}
    </>
  );
}
