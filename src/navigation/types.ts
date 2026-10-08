import type { NavigatorScreenParams } from '@react-navigation/native';

export type TabParamList = {
  Dashboard: undefined;
  CourtHome: undefined;
  CoolingOff: undefined;
  QuestionsVault: undefined;
};

export type RootStackParamList = {
  // signed out
  Login: undefined;
  // signed in, not paired
  Pairing: undefined;
  // paired
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  PlanDetail: { planId: string };
  NewCase: undefined;
  Verdict: { caseId: string };
};
