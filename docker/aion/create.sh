#!/bin/bash

{
    /usr/bin/expect << EOF
    spawn /opt/aion/aion.sh -a create
    expect "Please enter a password:"
    send "asd\r"
    expect "Please re-enter your password:"
    send "asd\r"
    expect "*#"
EOF
}