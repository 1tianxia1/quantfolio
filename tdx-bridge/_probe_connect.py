#!/usr/bin/env python3
# 连通性探测：硬编码 TDX 行情服务器 IP，短超时直接建连（绕过 select_best_ip 的挂死）。
import sys, os, socket, time

# 全局 socket 超时，防止任何意外挂死
socket.setdefaulttimeout(3.0)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from pytdx.hq import TdxHq_API

# 公开 TDX 行情服务器（沪深），端口 7709
HOSTS = [
    ("119.147.212.81", 7709),
    ("101.227.73.20", 7709),
    ("119.147.185.6", 7709),
    ("123.125.108.23", 7709),
    ("180.153.18.170", 7709),
    ("218.75.126.9", 7709),
    ("115.238.90.165", 7709),
    ("114.80.63.12", 7709),
]

print(f"探测 {len(HOSTS)} 个 TDX 行情服务器（单台超时 3s）...")
ok = []
for ip, port in HOSTS:
    t0 = time.time()
    try:
        api = TdxHq_API()
        # time_out 单位秒；连接失败抛异常或返回 False
        connected = api.connect(ip, port, time_out=2.0)
        dt = time.time() - t0
        if connected:
            # 试拉一只验证：贵州茅台 600519 最近 1 根日线
            try:
                bar = api.get_security_bars(9, 1, "600519", 0, 1)
                sample = bar[0] if bar else None
            except Exception as e:
                sample = f"get_security_bars 失败: {e}"
            api.disconnect()
            ok.append((ip, port, round(dt, 2), sample))
            print(f"  ✅ {ip}:{port} 连接成功 ({dt:.2f}s)")
        else:
            print(f"  ❌ {ip}:{port} connect 返回 False ({dt:.2f}s)")
    except Exception as e:
        dt = time.time() - t0
        print(f"  ❌ {ip}:{port} 异常: {type(e).__name__}: {str(e)[:80]} ({dt:.2f}s)")

print()
if ok:
    print(f"可达服务器数: {len(ok)}。首个可用: {ok[0][0]}:{ok[0][1]}")
    # 打印样本
    ip, port, dt, sample = ok[0]
    print(f"样本(600519 日线): {sample}")
    sys.exit(0)
else:
    print("全部不可达 —— 沙箱无通达信公网出口。")
    sys.exit(3)
