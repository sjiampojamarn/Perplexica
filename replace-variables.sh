#!/bin/bash

# Define a list of environment variables to check and replace
VARIABLES=("NEXT_PUBLIC_API_URL" "NEXT_PUBLIC_WS_URL")

# Check if each variable is set
for VAR in "${VARIABLES[@]}"; do
    if [ -z "${!VAR}" ]; then
        echo "$VAR is not set. Please set it and rerun the script."
        exit 1
    fi
done

# Find and replace BAKED values with real values
find ./public ./.next -type f -name "*.*" |
while read file; do
    for VAR in "${VARIABLES[@]}"; do
        sed -i "s|BAKED_$VAR|${!VAR}|g" "$file"
    done
done
