import { createApp } from 'vue'
import { QBadge, QBtn, QCheckbox, QIcon, QInput, Quasar, Notify } from 'quasar'
import 'quasar/dist/quasar.css'
import '@quasar/extras/roboto-font/roboto-font.css'
import '@quasar/extras/material-icons/material-icons.css'
import './style.css'
import App from './App.vue'

createApp(App)
  .use(Quasar, {
    components: {
      QBadge,
      QBtn,
      QCheckbox,
      QIcon,
      QInput,
    },
    plugins: {
      Notify,
    },
  })
  .mount('#app')
