import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.posecam.app',
  appName: 'LadduCam',
  webDir: 'build',
  server: {
    androidScheme: 'http',
    cleartext: true,
    allowNavigation: ['*']
  },
  android: {
    allowMixedContent: true
  }
};

export default config;
