import './HelpPage.css';

const FPS_CONTROLS = [
  {
    action: 'Se déplacer',
    keys: [['W', 'A', 'S', 'D'], ['↑', '↓', '←', '→']],
  },
  {
    action: 'Regarder autour',
    mouse: 'Glisser la souris',
  },
  {
    action: 'Sauter',
    keys: [['Espace']],
  },
  {
    action: 'Zoom (champ de vision)',
    mouse: 'Molette  /  Trackpad',
  },
  {
    action: 'Capturer la souris',
    mouse: 'Clic gauche sur la scène',
  },
  {
    action: 'Libérer la souris · Ouvrir le menu',
    keys: [['Échap']],
  },
];

const ORBIT_CONTROLS = [
  {
    action: 'Tourner',
    mouse: 'Glisser (bouton gauche)',
  },
  {
    action: 'Panoramique',
    mouse: 'Glisser (bouton droit ou milieu)',
  },
  {
    action: 'Zoom vers le curseur',
    mouse: 'Molette  /  Trackpad',
  },
  {
    action: 'Changer le point de pivot',
    mouse: 'Double-clic sur le modèle',
  },
  {
    action: 'Recadrer le modèle',
    keys: [['F']],
  },
];

function KeyRow({ keys }) {
  return (
    <span className="help-keys">
      {keys.map((group, gi) => (
        <span key={gi} className="help-key-group">
          {group.map((k, ki) => <kbd key={ki}>{k}</kbd>)}
          {gi < keys.length - 1 && <span className="help-or">ou</span>}
        </span>
      ))}
    </span>
  );
}

function ControlList({ items }) {
  return (
    <ul className="help-list">
      {items.map((item, i) => (
        <li key={i} className="help-item">
          {item.keys  && <KeyRow keys={item.keys} />}
          {item.mouse && <span className="help-mouse">{item.mouse}</span>}
          <span className="help-action">{item.action}</span>
        </li>
      ))}
    </ul>
  );
}

export default function HelpPage() {
  return (
    <div className="help-overlay">
      <div className="help-card">
        <h1 className="help-title">Commandes de navigation</h1>

        <div className="help-grid">
          <section className="help-section">
            <h2 className="help-section-title">
              <span className="help-icon">🎮</span> Mode FPS
            </h2>
            <ControlList items={FPS_CONTROLS} />
          </section>

          <div className="help-divider" />

          <section className="help-section">
            <h2 className="help-section-title">
              <span className="help-icon">🔭</span> Mode Orbite
            </h2>
            <ControlList items={ORBIT_CONTROLS} />
          </section>
        </div>

        <p className="help-footer">
          Utilisez le menu <strong>☰</strong> en haut à gauche pour naviguer entre les scènes.
        </p>
      </div>
    </div>
  );
}
