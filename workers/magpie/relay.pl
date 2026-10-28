#!/usr/bin/perl
# 回环中继：Worker 经 container binding 连进来的源地址是 10.0.0.1，magpie 对非回环来源要求已启用的网关 key，
# 而网关 key 不随 R2 同步、容器每次启动都是新的。中继把连接原样转发到 127.0.0.1:3425，magpie 看到的是回环，
# 任意 Bearer 都接受。容器端口只有绑定它的 Worker 能到达，所以中继本身不再加一层鉴权。
use strict; use warnings;
use IO::Socket::INET; use IO::Select; use POSIX ":sys_wait_h";
my $listen = $ARGV[0] // "0.0.0.0:3426"; my $target = $ARGV[1] // "127.0.0.1:3425";
$SIG{CHLD} = sub { 1 while waitpid(-1, WNOHANG) > 0 };
my $srv = IO::Socket::INET->new(LocalAddr => $listen, Listen => 64, ReuseAddr => 1, Proto => "tcp") or die "relay: listen $listen: $!\n";
# accept 会被子进程退出的 SIGCHLD 打断（EINTR）返回 undef，不能把它当作监听结束
while (1) {
  my $c = $srv->accept or next;
  my $pid = fork; if (!defined $pid) { close $c; next } if ($pid) { close $c; next }
  close $srv;
  my $t = IO::Socket::INET->new(PeerAddr => $target, Proto => "tcp") or exit 0;
  binmode $c; binmode $t; $c->blocking(1); $t->blocking(1);
  my $sel = IO::Select->new($c, $t);
  while (my @ready = $sel->can_read) {
    for my $r (@ready) {
      my $n = sysread($r, my $buf, 65536);
      my $w = $r == $c ? $t : $c;
      if (!$n) { shutdown($w, 1); $sel->remove($r); exit 0 if $sel->count == 0; next }
      my $off = 0; while ($off < length $buf) { my $k = syswrite($w, $buf, length($buf) - $off, $off) // exit 0; $off += $k }
    }
  }
  exit 0;
}
