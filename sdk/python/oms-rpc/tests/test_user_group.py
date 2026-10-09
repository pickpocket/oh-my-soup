from __future__ import annotations

from unittest.mock import patch

import pytest

from oms_rpc import RpcClient


class _Sentinel(Exception):
    pass


def _start_and_capture(**kwargs):
    client = RpcClient(**kwargs)
    with patch(
        "oms_rpc.client.subprocess.Popen", side_effect=_Sentinel("aborted")
    ) as mock_popen:
        with pytest.raises(_Sentinel):
            client.start()
    assert mock_popen.call_count == 1
    return mock_popen.call_args


def test_no_user_group_defaults_to_none():
    call = _start_and_capture(executable="oms")
    assert call.kwargs["user"] is None
    assert call.kwargs["group"] is None
    assert call.kwargs["extra_groups"] is None


def test_user_and_group_kwargs_threaded():
    call = _start_and_capture(
        executable="oms",
        user=2001,
        group="oms",
        extra_groups=[2000, "docker"],
    )
    assert call.kwargs["user"] == 2001
    assert call.kwargs["group"] == "oms"
    assert call.kwargs["extra_groups"] == [2000, "docker"]


def test_extra_groups_none_distinct_from_empty():
    call = _start_and_capture(executable="oms", extra_groups=[])
    # [] means an empty supplementary group list and differs from None.
    assert call.kwargs["extra_groups"] == []
