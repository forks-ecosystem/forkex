# Поиск процессов майнеров
ps aux | grep -E 'kinsing|kdevtmpfsi|minerd|xmrig|systemd-network|\.systemd'

# Проверьте автозагрузку
ls -la /etc/cron.d/
ls -la /etc/cron.hourly/
ls -la /etc/cron.daily/
ls -la /var/spool/cron/crontabs/

# Проверьте подозрительные файлы
find /tmp -name "*kinsing*" -o -name "*kdevtmpfsi*" -o -name "*systemd*"
find /var/tmp -name "*kinsing*" -o -name "*kdevtmpfsi*"
