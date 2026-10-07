import { Outlet } from 'react-router-dom';
import Navbar from './Navbar.jsx';

// Shared frame for every page: navbar on top, page content below, watermark on top of everything.
export default function Layout() {
  return (
    <>
      <Navbar />
      <main className="page">
        <Outlet />
      </main>
      <div className="watermark" aria-hidden="true">- KS SANGA -</div>
    </>
  );
}
