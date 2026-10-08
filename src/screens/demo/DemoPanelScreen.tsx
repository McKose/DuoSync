import { useEffect, useState } from 'react';
import { Switch, Text, View } from 'react-native';
import { clearQueryCache } from '@/api/queryClient';
import { AppButton } from '@/components/common/AppButton';
import { Screen } from '@/components/common/Screen';
import { Card, Chip, ErrorBanner, SectionTitle } from '@/components/common/StateViews';
import { demo, DEMO_PARTNER_NAME, type DemoSettings } from '@/demo';
import { confirmAction } from '@/lib/confirm';
import { useCoupleStore } from '@/store/useCoupleStore';
import type { PartnerStatus } from '@/types/database.types';

type Action = { label: string; hint?: string; run: () => Promise<unknown> };

/**
 * Demo-only control room: drive the simulated partner and the environment
 * (network, clock, latency) so every two-person and failure flow can be
 * tested on a single phone.
 */
export function DemoPanelScreen() {
  const paired = useCoupleStore((s) => Boolean(s.couple?.is_active));
  const [settings, setSettings] = useState<DemoSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    const load = () => void demo.panel.getSettings().then((s) => alive && setSettings(s));
    load();
    const off = demo.subscribe('settings', load);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = async (a: Action) => {
    setBusy(a.label);
    setError(null);
    setDone(null);
    try {
      await a.run();
      setDone(a.label);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const presence = (battery: number | null, status: PartnerStatus) => () =>
    demo.panel.setPartnerPresence(battery, status);

  const partnerActions: Action[] = [
    { label: `${DEMO_PARTNER_NAME} dava açsın`, hint: 'Mahkeme sekmesinde rozet çıkar', run: demo.panel.partnerFilesCase },
    { label: 'Savunma sürelerimi doldur', hint: 'Sweep 1 sn içinde savunmasız karar verir', run: demo.panel.expireMyDefenses },
    { label: `${DEMO_PARTNER_NAME} soğuma mesajı yazsın`, hint: '15 dk sonra (hızlı modda 15 sn) gelir', run: demo.panel.partnerSendsMessage },
    {
      label: `${DEMO_PARTNER_NAME} bekleyen mesajını geri çeksin`,
      hint: 'Sessiz iptal: sende HİÇBİR iz kalmamalı',
      run: demo.panel.partnerCancelsPending,
    },
    { label: `${DEMO_PARTNER_NAME} soru sorsun`, hint: 'Kasa sekmesi', run: demo.panel.partnerAsksQuestion },
    { label: `${DEMO_PARTNER_NAME} ilk maddeyi işaretlesin`, hint: 'Açık plan ekranında anlık değişmeli', run: demo.panel.partnerTogglesFirstItem },
  ];

  const presenceActions: Action[] = [
    { label: 'Pil %80 · Müsait', run: presence(80, 'NORMAL') },
    { label: 'Pil %12 · Şarjı azalıyor', run: presence(12, 'LOW_BATTERY') },
    { label: 'Meşgul', run: presence(55, 'BUSY') },
    { label: 'Hassas', run: presence(70, 'FRAGILE') },
  ];

  const confirmReset = () =>
    confirmAction({
      title: 'Demoyu sıfırla',
      message: 'Tüm demo verisi silinir ve giriş ekranına dönülür.',
      confirmLabel: 'Sıfırla',
      destructive: true,
      onConfirm: () =>
        void run({
          label: 'Sıfırlandı',
          run: async () => {
            await clearQueryCache();
            useCoupleStore.getState().reset();
            await demo.panel.reset();
          },
        }),
    });

  return (
    <Screen insetTop={false}>
      <Card className="bg-paper-sunk">
        <Text className="text-sm leading-5 text-ink">
          Bu sürüm hiçbir veritabanına bağlanmaz. Tüm veriler bu cihazda tutulur, partnerin {DEMO_PARTNER_NAME} simüle
          edilir ve hakem yapay zekâ değil, kurallı bir taklittir. Sunucudaki iş kuralları (savunma kilidi, sessiz iptal,
          checklist birleştirme, hata kodları) birebir uygulanır.
        </Text>
      </Card>

      <ErrorBanner error={error} />
      {done ? (
        <View className="mb-3 rounded-xl2 bg-sage-soft px-3 py-2" accessibilityLiveRegion="polite">
          <Text className="text-sm text-ink">✓ {done}</Text>
        </View>
      ) : null}

      <SectionTitle>Ortam</SectionTitle>
      <Card>
        <View className="mb-3 flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            <Text className="text-base font-semibold text-ink">Çevrimdışı simülasyonu</Text>
            <Text className="text-xs text-ink-mute">İstekler bekletilir; checklist değişiklikleri kuyruğa girer.</Text>
          </View>
          <Switch
            value={settings?.offline ?? false}
            onValueChange={(v) => void demo.panel.setOffline(v)}
            accessibilityLabel="Çevrimdışı simülasyonu"
          />
        </View>

        <Text className="mb-1.5 text-sm font-semibold text-ink-soft">Saat</Text>
        <View className="mb-2 flex-row flex-wrap">
          <Chip label="Hızlı · 1 dk = 1 sn" selected={settings?.timeScale === 60} onPress={() => void demo.panel.setTimeScale(60)} />
          <Chip label="Gerçek zaman" selected={settings?.timeScale === 1} onPress={() => void demo.panel.setTimeScale(1)} />
        </View>
        <Text className="mb-3 text-xs text-ink-mute">
          Soğuma süreleri ve 24 saatlik savunma süresi bu ölçekle işler. Yalnızca yeni kayıtlar etkilenir.
        </Text>

        <Text className="mb-1.5 text-sm font-semibold text-ink-soft">Ağ gecikmesi</Text>
        <View className="flex-row flex-wrap">
          {[0, 250, 1500].map((ms) => (
            <Chip key={ms} label={ms === 0 ? 'Yok' : `${ms} ms`} selected={settings?.latencyMs === ms} onPress={() => void demo.panel.setLatency(ms)} />
          ))}
        </View>
      </Card>

      <SectionTitle>{`${DEMO_PARTNER_NAME} (simüle partner)`}</SectionTitle>
      {paired ? (
        <>
          <Card>
            {partnerActions.map((a) => (
              <View key={a.label} className="mb-3">
                <AppButton label={a.label} variant="secondary" loading={busy === a.label} onPress={() => void run(a)} />
                {a.hint ? <Text className="mt-1 text-xs text-ink-mute">{a.hint}</Text> : null}
              </View>
            ))}
          </Card>
          <Card>
            <Text className="mb-2 text-sm font-semibold text-ink-soft">Durumu</Text>
            <View className="flex-row flex-wrap">
              {presenceActions.map((a) => (
                <Chip key={a.label} tone="sage" label={a.label} selected={false} onPress={() => void run(a)} />
              ))}
            </View>
          </Card>
          <Text className="mb-2 text-xs text-ink-mute">
            Otomatik tepkiler: açtığın davaya ~8 sn içinde savunma verir, karar ~2.5 sn sonra çıkar; sorduğun soruyu ~6 sn
            içinde cevaplar.
          </Text>
        </>
      ) : (
        <Card>
          <Text className="text-sm text-ink-soft">
            Önce eşleş: kod oluşturursan {DEMO_PARTNER_NAME} 5 sn içinde katılır; ya da 6 karakterlik herhangi bir kodu gir (ör.
            K7M2QX).
          </Text>
        </Card>
      )}

      <SectionTitle>Veri</SectionTitle>
      <AppButton label="Demoyu sıfırla" variant="danger" loading={busy === 'Sıfırlandı'} onPress={confirmReset} />
    </Screen>
  );
}
