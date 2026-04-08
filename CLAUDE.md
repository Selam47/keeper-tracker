KEEPER TRACKER - TEKNİK ÖZET VE PROJE MANTIĞI

1. PROJE TANIMI VE AMACI

Amaç: Orijinal uygulaması desteklenmeyen Gigaset Keeper (Bluetooth Tracker) cihazları için Web Bluetooth API tabanlı bir takip uygulaması geliştirmek.

Kapsam: ~400 cihazlık bir operasyon için kullanıcı odaklı, cihaz eşleştirme, pil takibi, mesafe ölçümü ve "cihazı bul" özelliklerini içeren web tabanlı bir çözüm.

Hedef Kitle: Android ve Masaüstü Chrome/Edge kullanıcıları.

2. TEKNİK ÖZELLİKLER (BLE STACK)

Cihaz: Gigaset Keeper (BLE 4.0, Dialog DA14580 çip).

Protokol: Web Bluetooth API (HTTPS zorunluluğu).

Hizmet ve Karakteristik Haritası:

Ana Servis (0xFEF5): Kontrol işlemlerini yönetir.

LED Kontrol: 8082caa8-41a6-4021-91c6-56f9b954cc34 (0x01: Yak, 0x00: Söndür).

Pil Servisi (0x180F): 0x2A19 karakteristiği üzerinden % olarak pil seviyesini verir.

Buton Servisi (6d696368-616c-206f-6c65-737a637a796b): 66696c69-7020-726f-6d61-6e6f77736b69 karakteristiği ile buton basışlarını (NOTIFY) dinler.

3. YAZILIM MİMARİSİ VE STACK

Frontend: HTML5, CSS3, JavaScript (Modüler yapı).

Deployment: Netlify (HTTPS ve PWA desteği için).

Backend/Database: Supabase (Auth ve Cihaz Verileri için).

Veritabanı Şeması:

profiles: Kullanıcı giriş bilgileri.

keeper_devices: user_id, device_name, mac_address, icon_type.

4. TEMEL İŞLEM MANTIKLARI

Cihaz Ekleme: navigator.bluetooth.requestDevice ile