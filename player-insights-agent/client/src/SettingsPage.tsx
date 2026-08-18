/**
 * App settings: the page the gear in the header opens.
 *
 * Split out of App.tsx when the pages became modules. The flags it edits reach
 * it through the router outlet, which is why it is a page rather than something
 * the header renders itself: the header and this page are then looking at one
 * object and a toggle moves both in the same render.
 */
import { Link, useOutletContext } from 'react-router';
import { AdminListEditor } from './AdminListEditor';
import { UserRoleEditor } from './UserRoleEditor';
import { showsEgressControls } from './experimental-features';
import { EgressPanel } from './EgressPanel';
import { showsAdminSurfaces, showsUserRoster, useRole } from './role';
import {
  Button,
  Card,
  CardDescription,
  CardContent,
  CardHeader,
  CardTitle,
  Switch,
} from './ui';
import { PlugZap } from 'lucide-react';
import { PageHeading } from './page-chrome';
import type { ExperimentalFeaturesHandle } from './app-types';

/**
 * What the gear opens: preferences that belong to the reader and to this browser.
 *
 * The split from Connections is the whole design of this page, so it is worth
 * saying where the line is. Here: choices one person makes about what the app
 * shows THEM, held in their own browser, costing nobody else anything.
 * Connections: what this deployment IS -- its catalogs, warehouses, serving and
 * judge endpoints, the preflight report and the identity record -- which is
 * server-side, shared by everybody using the app, and where a wrong value is a
 * broken deployment rather than a hidden tab.
 *
 * Those are different kinds of change, and the editor for the second is entangled
 * with the reporting beside it: it reads and writes `/api/settings` and
 * `/api/settings/values/:id` and shows the preflight those values produced. It
 * has not been moved here, and should not be moved here just to make the gear
 * feel complete. The link below is the join, and it is a link rather than an
 * embed for the same reason the pages are separate.
 *
 * That reasoning stays in this comment and does not appear on the page. A
 * paragraph arguing why deployment configuration is somewhere else was on screen
 * and was cut: it explained a design decision to a reader who had come to flip a
 * switch. Each card says what its controls do and where the other ones are, and
 * nothing here argues for how the app was built.
 *
 * THE ADMINISTRATORS CARD IS THE ONE EXCEPTION to the line above, and it is worth
 * being explicit about why it is not in Connections. It is not a per-browser
 * preference: it changes who can open Monitoring and Ops for everybody. But it is
 * also not a deployment resource. It appoints a PERSON, and it belongs beside the
 * gear that only administrators can see, rather than in a page about catalogs and
 * endpoints. It is first because it is the most consequential control here, and
 * the page's own description is written so that it does not claim otherwise.
 */
export function SettingsPage() {
  const { features, setFeature } = useOutletContext<ExperimentalFeaturesHandle>();
  const role = useRole();

  return (<div className="page-shell settings-page">
      {/* Titled to match the gear's accessible name exactly, which is "App
          settings" and not "Settings" -- see the header. A heading and a link do
          not collide as locators, and settings is still not a nav entry, so the
          word stays unambiguous. */}
      <PageHeading title="App settings" />

      {/* First, above the administrator list, because it is the more consequential
          of the two: it decides who may change that list. Absent for an
          administrator rather than shown with dead controls, and `/api/users`
          refuses them on the server whatever is drawn here. */}
      {showsUserRoster(role.state) ? <UserRoleEditor /> : null}

      <AdminListEditor />

      <Card>
        <CardHeader>
          <CardTitle>Experimental features</CardTitle>
          <CardDescription>Unfinished or internal surfaces, off by default.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="settings-row">
            <div>
              <p className="settings-row-label">Egress controls</p>
              <p className="settings-row-note">
                Shows what leaves this deployment and which paths may be turned off. Hiding it does
                not change what is permitted.
              </p>
            </div>
            <Switch
              checked={showsEgressControls(features)}
              onCheckedChange={(enabled) => setFeature('egressControls', enabled)}
              aria-label="Show the egress controls on this page"
            />
          </div>
        </CardContent>
      </Card>

      {/* Below the toggle that reveals it, so turning it on does not move the
          switch the reader just used. Administrators only: the two routes it
          reads are refused for anybody else on the server whatever is drawn
          here, so this is about not offering dead cards. */}
      {showsEgressControls(features) && showsAdminSurfaces(role.state) ? <EgressPanel /> : null}

      <Card>
        <CardHeader>
          <CardTitle>Deployment and resources</CardTitle>
          <CardDescription>Deployment settings are in Connections.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/connections">
              <PlugZap /> Open Connections
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
