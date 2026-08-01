// Must be the first import in the app. Hermes ships no Web Crypto, so
// `crypto.getRandomValues` is undefined until this runs — and every key in the
// protocol comes from it: `ed25519.keygen()`, every message id, every nonce.
// Without it the first call throws, `loadOrCreateIdentity()` rejects before the
// UI mounts, and the app sits on its loading spinner with nothing in the log.
//
// This is a dependency the core rule about writing things ourselves does not
// cover: a CSPRNG cannot be implemented in JavaScript. It needs the platform's
// entropy source, and this package is the thin native binding to it.
import 'react-native-get-random-values';

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
