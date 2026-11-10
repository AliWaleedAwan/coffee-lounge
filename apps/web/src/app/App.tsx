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
import { AssetsScreen } from '../screens/assets/AssetsScreen.tsx';
import { AuditScreen } from '../screens/audit/AuditScreen.tsx';
import { ExpensesScreen } from '../screens/expenses/ExpensesScreen.tsx';
import { InventoryScreen } from '../screens/inventory/InventoryScreen.tsx';
import { LedgerScreen } from '../screens/ledger/LedgerScreen.tsx';
import { ApprovalsScreen } from '../screens/approvals/ApprovalsScreen.tsx';
import { CounterScreen } from '../screens/counter/CounterScreen.tsx';
import { RefundsScreen } from '../screens/counter/RefundsScreen.tsx';
import { ShiftScreen } from '../screens/counter/ShiftScreen.tsx';
import { DeliveryScreen } from '../screens/delivery/DeliveryScreen.tsx';
import { FloorScreen } from '../screens/floor/FloorScreen.tsx';
import { SessionScreen } from '../screens/session/SessionScreen.tsx';
import { PickupScreen } from '../screens/pickup/PickupScreen.tsx';
import { PrintJobsScreen } from '../screens/printing/PrintJobsScreen.tsx';
import { HardwareScreen } from '../screens/hardware/HardwareScreen.tsx';
import { CustomersScreen } from '../screens/oldpos/CustomersScreen.tsx';
import { OldSalesScreen } from '../screens/oldpos/OldSalesScreen.tsx';
import { ReceiptDesignScreen } from '../screens/settings/ReceiptDesignScreen.tsx';
import { SettingsScreen } from '../screens/settings/SettingsScreen.tsx';
import { MenuScreen } from '../screens/menu/MenuScreen.tsx';
import { OperationsScreen } from '../screens/operations/OperationsScreen.tsx';
import { LoginScreen } from '../screens/LoginScreen.tsx';
import { PinScreen } from '../screens/PinScreen.tsx';
import { RegisterScreen } from '../screens/RegisterScreen.tsx';
import { ReportsScreen } from '../screens/reports/ReportsScreen.tsx';
import { UsersScreen } from '../screens/users/UsersScreen.tsx';
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
  approvals: ApprovalsScreen,
  assets: AssetsScreen,
  audit: AuditScreen,
  counter: CounterScreen,
  deliveries: DeliveryScreen,
  devices: DevicesScreen,
  expenses: ExpensesScreen,
  floor: FloorScreen,
  health: HealthScreen,
  inventory: InventoryScreen,
  ledger: LedgerScreen,
  menu: MenuScreen,
  operations: OperationsScreen,
  pickup: PickupScreen,
  reports: ReportsScreen,
  'receipt-design': ReceiptDesignScreen,
  settings: SettingsScreen,
  hardware: HardwareScreen,
  customers: CustomersScreen,
  'old-sales': OldSalesScreen,
  users: UsersScreen,
};

const FLOOR = AREAS.find((a) => a.id === 'floor');
const COUNTER = AREAS.find((a) => a.id === 'counter');
/** Reached from Bills & payments; cashiers, managers and the owner run the till shift. */
const CASH_SHIFT = COUNTER ? { ...COUNTER, anyOf: ['cash_shifts.operate'] } : null;
/** Reached from Bills & payments, the delivery board and the inbox (D-13: asking needs payments.refund_request). */
const REFUNDS = COUNTER ? { ...COUNTER, anyOf: ['payments.refund_request'] } : null;
/** Reached from the printer banner, not the menu. */
const PRINT_JOBS = {
  id: 'print-jobs',
  label: 'Print jobs',
  path: '/print-jobs',
  anyOf: ['kitchen.reprint'],
  ready: true,
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
        <Route
          path="/print-jobs"
          element={
            <AreaPage area={PRINT_JOBS}>
              <PrintJobsScreen />
            </AreaPage>
          }
        />
        {FLOOR ? (
          <Route
            path="/sessions/:sessionId"
            element={
              <AreaPage area={FLOOR}>
                <SessionScreen />
              </AreaPage>
            }
          />
        ) : null}
        {REFUNDS ? (
          <Route
            path="/counter/refunds"
            element={
              <AreaPage area={REFUNDS}>
                <RefundsScreen />
              </AreaPage>
            }
          />
        ) : null}
        {CASH_SHIFT ? (
          <Route
            path="/counter/shift"
            element={
              <AreaPage area={CASH_SHIFT}>
                <ShiftScreen />
              </AreaPage>
            }
          />
        ) : null}
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
