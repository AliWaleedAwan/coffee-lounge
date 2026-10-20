/** Routes and providers for the staff app. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { JSX } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError } from '../api/client.ts';
import { permissionSet } from '../auth/session.ts';
import { HealthPoller } from '../connection/ConnectionBanner.tsx';
import { AREAS, homePath } from '../nav/areas.ts';
import { AccountScreen } from '../screens/AccountScreen.tsx';
import { DevicesScreen } from '../screens/DevicesScreen.tsx';
import { HealthScreen } from '../screens/HealthScreen.tsx';
import { FloorScreen } from '../screens/floor/FloorScreen.tsx';
import { MenuScreen } from '../screens/menu/MenuScreen.tsx';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { PinScreen } from '../screens/PinScreen.tsx';
import { RegisterScreen } from '../screens/RegisterScreen.tsx';
import { AreaPage, RequireSession, useSignedIn } from '../screens/Shell.tsx';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Hints and focus decide freshness; never refetch on a timer (see api/activity.ts).
        staleTime: 10_000,
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

const BUILT: Record<string, () => JSX.Element> = {
  devices: DevicesScreen,
  floor: FloorScreen,
  health: HealthScreen,
  menu: MenuScreen,
};

function Home() {
  return <Navigate to={homePath(permissionSet(useSignedIn()))} replace />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/register" element={<RegisterScreen />} />
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/pin" element={<PinScreen />} />
      <Route element={<RequireSession />}>
        <Route index element={<Home />} />
        <Route path="/account" element={<AccountScreen />} />
        {AREAS.map((area) => {
          const Screen = BUILT[area.id];
          return (
            <Route
              key={area.id}
              path={area.path}
              element={<AreaPage area={area}>{Screen ? <Screen /> : null}</AreaPage>}
            />
          );
        })}
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}

export function App({ client }: { client: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <HealthPoller />
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
