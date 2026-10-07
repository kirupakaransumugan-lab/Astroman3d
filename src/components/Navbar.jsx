import { Link, NavLink } from 'react-router-dom';
import { PAGES } from '../pages.js';

export default function Navbar() {
  return (
    <header className="navbar">
      <Link to="/" className="brand">Astro <span>Walk</span></Link>
      <nav aria-label="Main">
        <ul>
          {PAGES.map(({ path, label }) => (
            <li key={path}>
              <NavLink to={path} end>{label}</NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
